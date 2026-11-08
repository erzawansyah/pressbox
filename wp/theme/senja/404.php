<?php
/**
 * Not found page.
 */

get_header();
?>
<div class="container py-24 text-center">
	<h1 class="font-display text-5xl font-bold"><?php esc_html_e( 'This page is not on the menu', 'senja' ); ?></h1>
	<p class="mt-6"><a class="btn btn-primary" href="<?php echo esc_url( home_url( '/' ) ); ?>"><?php esc_html_e( 'Back home', 'senja' ); ?></a></p>
</div>
<?php
get_footer();
