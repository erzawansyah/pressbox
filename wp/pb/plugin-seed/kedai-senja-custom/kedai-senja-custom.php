<?php
/**
 * Plugin Name: Kedai Senja Custom
 * Description: Satu-satunya plugin kustom situs Kedai Kopi Senja. Semua fitur situs ada di sini. Dikelola lewat PressBox.
 * Version: 1.0.0
 * Author: Kedai Kopi Senja
 * License: MIT
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'KSS_VERSION', '1.0.0' );

/**
 * Shortcode [kss_jam_buka]: tabel jam buka kedai.
 */
function kss_jam_buka_shortcode() {
	$jadwal = array(
		'Senin - Jumat' => '07.00 - 22.00',
		'Sabtu'         => '08.00 - 23.00',
		'Minggu'        => '08.00 - 21.00',
	);

	$html = '<table class="kss-jam-buka"><tbody>';
	foreach ( $jadwal as $hari => $jam ) {
		$html .= '<tr><td>' . esc_html( $hari ) . '</td><td>' . esc_html( $jam ) . '</td></tr>';
	}
	$html .= '</tbody></table>';

	return $html;
}
add_shortcode( 'kss_jam_buka', 'kss_jam_buka_shortcode' );
