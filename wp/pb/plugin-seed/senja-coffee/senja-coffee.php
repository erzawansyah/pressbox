<?php
/**
 * Plugin Name: Senja Coffee
 * Description: The single custom plugin of the Senja Coffee site. Every site feature lives here; changes arrive through PressBox.
 * Version: 1.0.0
 * Author: Senja Coffee
 * License: MIT
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SENJA_VERSION', '1.0.0' );

/**
 * [senja_opening_hours]: opening hours table.
 */
function senja_opening_hours_shortcode() {
	$hours = array(
		'Monday - Friday' => '07:00 - 22:00',
		'Saturday'        => '08:00 - 23:00',
		'Sunday'          => '08:00 - 21:00',
	);

	$html = '<table class="senja-opening-hours"><tbody>';
	foreach ( $hours as $days => $time ) {
		$html .= '<tr><td>' . esc_html( $days ) . '</td><td>' . esc_html( $time ) . '</td></tr>';
	}
	$html .= '</tbody></table>';

	return $html;
}
add_shortcode( 'senja_opening_hours', 'senja_opening_hours_shortcode' );
