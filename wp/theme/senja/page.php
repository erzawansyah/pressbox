<?php
/**
 * Regular pages (Menu, About, Contact and anything the owner adds).
 */

get_header();

while ( have_posts() ) :
	the_post();
	?>
	<article id="post-<?php the_ID(); ?>" <?php post_class(); ?>>
		<header class="page-banner">
			<div class="container py-16 md:py-20">
				<p class="eyebrow text-terracotta"><?php bloginfo( 'name' ); ?></p>
				<h1 class="mt-3 font-display text-4xl font-bold tracking-tight md:text-6xl"><?php the_title(); ?></h1>
			</div>
		</header>
		<div class="container">
			<div class="entry-content mx-auto max-w-3xl">
				<?php the_content(); ?>
			</div>
		</div>
	</article>
	<?php
endwhile;

get_footer();
