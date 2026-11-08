<?php
/**
 * Fallback template (posts, archives, search). The demo site is pages-only.
 */

get_header();
?>
<div class="container py-16">
	<div class="entry-content mx-auto max-w-3xl">
		<?php if ( have_posts() ) : ?>
			<?php while ( have_posts() ) : the_post(); ?>
				<h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
				<?php the_excerpt(); ?>
			<?php endwhile; ?>
		<?php else : ?>
			<h1><?php esc_html_e( 'Nothing here yet', 'senja' ); ?></h1>
		<?php endif; ?>
	</div>
</div>
<?php
get_footer();
