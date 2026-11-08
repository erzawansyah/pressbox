<?php
/**
 * PressBox Agent (must-use plugin).
 *
 * Ships with every PressBox-managed WordPress, production and sandbox alike. Being a
 * must-use plugin it cannot be deactivated from wp-admin, which is the point: it is the
 * site's link to PressBox.
 *
 * - `wp pressbox profile` prints the server profile as JSON. The control plane reads it
 *   from production and turns it into constraints: sandboxes copy the PHP limits, the
 *   agent is told what the server supports, and the gate rejects code that needs a
 *   PHP extension production does not have.
 * - Plugin/theme installs, updates and file edits are disabled in wp-admin, so every
 *   change goes through PressBox (sandbox, gate, review) instead of around it.
 * - wp-admin shows that the site is managed and links to the PressBox chat.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const PRESSBOX_PROFILE_EXTENSIONS = array( 'curl', 'gd', 'imagick', 'intl', 'mbstring', 'openssl', 'pdo_sqlite', 'mysqli', 'sodium', 'zip', 'exif', 'fileinfo' );

/**
 * Facts about the server and site that bound what a change may rely on.
 */
function pressbox_server_profile() {
	global $wpdb;

	$theme = wp_get_theme();
	if ( ! function_exists( 'get_plugins' ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
	}
	$active_plugins = array();
	foreach ( get_plugins() as $file => $plugin ) {
		if ( is_plugin_active( $file ) ) {
			$active_plugins[] = array(
				'file'    => $file,
				'name'    => $plugin['Name'],
				'version' => $plugin['Version'],
			);
		}
	}

	return array(
		'php_version'        => PHP_VERSION,
		'php_memory_limit'   => ini_get( 'memory_limit' ),
		'max_execution_time' => (int) ini_get( 'max_execution_time' ),
		'upload_max_size'    => ini_get( 'upload_max_filesize' ),
		'extensions'         => array_values( array_filter( PRESSBOX_PROFILE_EXTENSIONS, 'extension_loaded' ) ),
		'missing_extensions' => array_values( array_filter( PRESSBOX_PROFILE_EXTENSIONS, fn( $ext ) => ! extension_loaded( $ext ) ) ),
		'wp_version'         => get_bloginfo( 'version' ),
		'environment'        => wp_get_environment_type(),
		'database'           => defined( 'DB_ENGINE' ) && 'sqlite' === DB_ENGINE ? 'sqlite' : 'mysql ' . $wpdb->db_version(),
		'theme'              => array(
			'name'        => $theme->get( 'Name' ),
			'block_theme' => $theme->is_block_theme(),
		),
		'active_plugins'     => $active_plugins,
		'https'              => is_ssl() || 0 === strpos( home_url(), 'https://' ),
	);
}

// WP-CLI runs with the CLI php.ini (often no memory or time limit), so limits read there
// say nothing about what visitors' requests get. The profile command therefore asks the
// web server itself through a loopback request, authenticated with a per-site token.
const PRESSBOX_PROFILE_TOKEN_OPTION = 'pressbox_profile_token';

add_action(
	'plugins_loaded',
	function () {
		if ( ! isset( $_GET['pressbox_profile'] ) ) {
			return;
		}
		$expected = (string) get_option( PRESSBOX_PROFILE_TOKEN_OPTION, '' );
		$given    = isset( $_SERVER['HTTP_X_PRESSBOX_TOKEN'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_PRESSBOX_TOKEN'] ) ) : '';
		if ( '' === $expected || ! hash_equals( $expected, $given ) ) {
			status_header( 403 );
			exit;
		}
		wp_send_json( pressbox_server_profile() + array( 'source' => 'web' ) );
	},
	0
);

function pressbox_web_profile() {
	$token = (string) get_option( PRESSBOX_PROFILE_TOKEN_OPTION, '' );
	if ( '' === $token ) {
		$token = wp_generate_password( 40, false );
		update_option( PRESSBOX_PROFILE_TOKEN_OPTION, $token, false );
	}
	$internal = getenv( 'PB_INTERNAL_URL' ) ? getenv( 'PB_INTERNAL_URL' ) : 'http://127.0.0.1:8080';
	$response = wp_remote_get(
		$internal . '/?pressbox_profile=1',
		array(
			'timeout' => 10,
			'headers' => array(
				'X-PressBox-Token' => $token,
				'Host'             => wp_parse_url( home_url(), PHP_URL_HOST ) . ( wp_parse_url( home_url(), PHP_URL_PORT ) ? ':' . wp_parse_url( home_url(), PHP_URL_PORT ) : '' ),
			),
		)
	);
	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		return null;
	}
	return json_decode( wp_remote_retrieve_body( $response ), true );
}

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	WP_CLI::add_command(
		'pressbox profile',
		function () {
			$profile = pressbox_web_profile();
			if ( ! $profile ) {
				WP_CLI::warning( 'Web loopback failed; reporting CLI limits, which may differ from the web server.' );
				$profile = pressbox_server_profile() + array( 'source' => 'cli' );
			}
			WP_CLI::line( wp_json_encode( $profile ) );
		}
	);
}

// All code changes go through PressBox; wp-admin cannot install, update or edit files.
add_filter( 'file_mod_allowed', '__return_false' );

add_action(
	'admin_bar_menu',
	function ( WP_Admin_Bar $bar ) {
		$chat = getenv( 'PB_CONTROL_URL' );
		$bar->add_node(
			array(
				'id'    => 'pressbox',
				'title' => 'Managed by PressBox',
				'href'  => $chat ? $chat : false,
				'meta'  => array( 'title' => 'Changes to this site are made through PressBox chat and tested in a sandbox first.' ),
			)
		);
	},
	100
);

add_action(
	'admin_notices',
	function () {
		$screen = get_current_screen();
		if ( ! $screen || ! in_array( $screen->id, array( 'plugins', 'themes', 'dashboard' ), true ) ) {
			return;
		}
		$chat = getenv( 'PB_CONTROL_URL' );
		printf(
			'<div class="notice notice-info"><p><strong>This site is managed by PressBox.</strong> Plugin and theme changes are disabled here. Describe the change in the %s; it is built and tested in a sandbox before it reaches this site.</p></div>',
			$chat ? '<a href="' . esc_url( $chat ) . '">PressBox chat</a>' : 'PressBox chat'
		);
	}
);
