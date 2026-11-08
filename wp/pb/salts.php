<?php
// Prints fresh WordPress salts as PHP defines. Run at container start.
echo "<?php\n";
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $key ) {
	echo "define( '" . $key . "', '" . bin2hex( random_bytes( 32 ) ) . "' );\n";
}
