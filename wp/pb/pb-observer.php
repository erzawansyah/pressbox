<?php
/**
 * PressBox sandbox observer.
 * Installed only inside sandboxes (never on the live site). Records outbound HTTP attempts
 * and fatal errors to /tmp/pb-observer.log so the control-plane gate can judge the run.
 * The sandbox network has no route out, so recorded attempts always fail; this file only observes.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function pb_observer_write( array $entry ) {
	$entry = array( 'time' => gmdate( 'c' ) ) + $entry;
	@file_put_contents( '/tmp/pb-observer.log', json_encode( $entry ) . "\n", FILE_APPEND | LOCK_EX );
}

add_action(
	'http_api_debug',
	function ( $response, $context, $class, $args, $url ) {
		pb_observer_write(
			array(
				'type'   => 'http',
				'url'    => (string) $url,
				'method' => isset( $args['method'] ) ? (string) $args['method'] : 'GET',
				'error'  => is_wp_error( $response ) ? $response->get_error_message() : null,
			)
		);
	},
	10,
	5
);

register_shutdown_function(
	function () {
		$error = error_get_last();
		if ( $error && in_array( $error['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR ), true ) ) {
			pb_observer_write(
				array(
					'type'    => 'fatal',
					'message' => $error['message'],
					'file'    => $error['file'],
					'line'    => $error['line'],
				)
			);
		}
	}
);
