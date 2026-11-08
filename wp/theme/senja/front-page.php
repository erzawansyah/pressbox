<?php
/**
 * Home: hero built from the site title and tagline (so a tagline change shows at once),
 * then the Home page content.
 */

get_header();
?>
<section class="hero relative overflow-hidden">
	<div class="container grid items-center gap-12 py-20 md:grid-cols-[1.2fr_1fr] md:py-28">
		<div>
			<p class="eyebrow text-terracotta"><?php esc_html_e( 'Malang · since 2019', 'senja' ); ?></p>
			<h1 class="mt-4 font-display text-5xl font-bold leading-[1.05] tracking-tight text-balance md:text-7xl"><?php bloginfo( 'description' ); ?></h1>
			<div class="mt-10 flex flex-wrap gap-3">
				<a href="<?php echo esc_url( senja_page_url( 'menu' ) ); ?>" class="btn btn-primary"><?php esc_html_e( 'See the menu', 'senja' ); ?></a>
				<a href="<?php echo esc_url( senja_page_url( 'contact' ) ); ?>" class="btn btn-ghost"><?php esc_html_e( 'Hours & location', 'senja' ); ?></a>
			</div>
		</div>
		<div class="hero-art" aria-hidden="true">
			<div class="hero-sun"></div>
			<div class="hero-cup">
				<svg viewBox="0 0 200 170" class="w-full" fill="none">
					<path d="M60 18c0 12 12 12 12 24M96 10c0 12 12 12 12 24M132 18c0 12 12 12 12 24" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity=".55"/>
					<path d="M28 62h132v38a58 58 0 0 1-58 58H86a58 58 0 0 1-58-58V62Z" fill="currentColor"/>
					<path d="M160 76h10a22 22 0 0 1 0 44h-12" stroke="currentColor" stroke-width="10"/>
				</svg>
			</div>
		</div>
	</div>
</section>

<?php while ( have_posts() ) : the_post(); ?>
	<section class="container">
		<div class="entry-content mx-auto max-w-3xl">
			<?php the_content(); ?>
		</div>
	</section>
<?php endwhile; ?>
<?php
get_footer();
