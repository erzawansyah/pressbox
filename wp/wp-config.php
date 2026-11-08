<?php
/**
 * PressBox generic wp-config.
 * Shared by the demo live site and all sandboxes. Contains no secrets:
 * SQLite needs no DB password, salts come from /tmp/pb-salts.php generated at container start,
 * and the site URL comes from the PB_HOME env (live URL or the sandbox preview URL).
 */

define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'DB_DIR', __DIR__ . '/wp-content/database/' );
define( 'DB_FILE', '.ht.sqlite' );

$pb_home = getenv( 'PB_HOME' ) ?: 'http://localhost:8080';
define( 'WP_HOME', rtrim( $pb_home, '/' ) );
define( 'WP_SITEURL', rtrim( $pb_home, '/' ) );

// TLS ends at the reverse proxy and PHP sees plain HTTP, so state the public scheme.
if ( str_starts_with( $pb_home, 'https://' ) ) {
	$_SERVER['HTTPS'] = 'on';
}

// TLS ends at the reverse proxy; PHP sees plain HTTP, so tell WordPress the public scheme.
if ( str_starts_with( $pb_home, 'https://' ) ) {
	$_SERVER['HTTPS'] = 'on';
}

if ( file_exists( '/tmp/pb-salts.php' ) ) {
	require '/tmp/pb-salts.php';
}

$table_prefix = 'wp_';

define( 'WP_DEBUG', true );
define( 'WP_DEBUG_LOG', '/tmp/wp-debug.log' );
define( 'WP_DEBUG_DISPLAY', false );
define( 'WP_MEMORY_LIMIT', '128M' );
define( 'WP_MAX_MEMORY_LIMIT', '128M' );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_AUTO_UPDATE_CORE', false );
define( 'DISALLOW_FILE_EDIT', true );
define( 'FS_METHOD', 'direct' );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
