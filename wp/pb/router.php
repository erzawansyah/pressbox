<?php
/**
 * Router for PHP's built-in server.
 * Supports serving WordPress under a path prefix (sandbox previews live at /preview/<id>/),
 * derived from the path part of PB_HOME. The live site has no prefix.
 * Must stay at top level (no functions around the require) so WordPress runs in global scope.
 */

$pb_docroot = '/srv/wordpress';
$pb_prefix  = rtrim( (string) parse_url( (string) getenv( 'PB_HOME' ), PHP_URL_PATH ), '/' );
$pb_uri     = (string) parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$pb_uri     = rawurldecode( $pb_uri );

if ( '' !== $pb_prefix && 0 === strpos( $pb_uri, $pb_prefix ) ) {
	$pb_path = substr( $pb_uri, strlen( $pb_prefix ) );
} else {
	$pb_path = $pb_uri;
}
if ( '' === $pb_path ) {
	$pb_path = '/';
}

// Never serve the database, backups or dotfiles.
if ( preg_match( '#(^|/)\.|/wp-content/(database|pb-backups)/#', $pb_path ) || false !== strpos( $pb_path, '..' ) ) {
	http_response_code( 403 );
	echo 'Forbidden';
	return true;
}

$pb_file = $pb_docroot . $pb_path;
if ( is_dir( $pb_file ) ) {
	$pb_file = rtrim( $pb_file, '/' ) . '/index.php';
	$pb_path = rtrim( $pb_path, '/' ) . '/index.php';
}

if ( is_file( $pb_file ) && ! preg_match( '/\.php$/i', $pb_file ) ) {
	$pb_types = array(
		'css'   => 'text/css',
		'js'    => 'application/javascript',
		'json'  => 'application/json',
		'png'   => 'image/png',
		'jpg'   => 'image/jpeg',
		'jpeg'  => 'image/jpeg',
		'gif'   => 'image/gif',
		'svg'   => 'image/svg+xml',
		'webp'  => 'image/webp',
		'ico'   => 'image/x-icon',
		'woff'  => 'font/woff',
		'woff2' => 'font/woff2',
		'ttf'   => 'font/ttf',
		'txt'   => 'text/plain',
		'map'   => 'application/json',
		'html'  => 'text/html',
	);
	$pb_ext = strtolower( pathinfo( $pb_file, PATHINFO_EXTENSION ) );
	header( 'Content-Type: ' . ( $pb_types[ $pb_ext ] ?? 'application/octet-stream' ) );
	header( 'Content-Length: ' . filesize( $pb_file ) );
	header( 'Cache-Control: public, max-age=300' );
	readfile( $pb_file );
	return true;
}

if ( ! is_file( $pb_file ) ) {
	// Front controller: let WordPress resolve the request.
	$pb_file = $pb_docroot . '/index.php';
	$pb_path = '/index.php';
}

$_SERVER['SCRIPT_FILENAME'] = $pb_file;
$_SERVER['SCRIPT_NAME']     = $pb_prefix . $pb_path;
$_SERVER['PHP_SELF']        = $pb_prefix . $pb_path;
$_SERVER['DOCUMENT_ROOT']   = $pb_docroot;

chdir( dirname( $pb_file ) );
unset( $pb_docroot, $pb_uri, $pb_types, $pb_ext );
require $pb_file;
