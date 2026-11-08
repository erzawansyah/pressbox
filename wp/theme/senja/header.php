<?php
/**
 * Site header: brand, page navigation and a reservation call to action.
 */
?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<?php wp_head(); ?>
</head>
<body <?php body_class( 'bg-cream text-espresso antialiased font-sans' ); ?>>
<?php wp_body_open(); ?>
<div id="page" class="min-h-screen flex flex-col">
	<header class="sticky top-0 z-30 border-b border-espresso/10 bg-cream/90 backdrop-blur">
		<div class="container flex items-center justify-between gap-6 py-4">
			<a href="<?php echo esc_url( home_url( '/' ) ); ?>" class="flex items-center gap-3 no-underline">
				<span class="grid size-10 place-items-center rounded-full bg-espresso text-cream" aria-hidden="true">
					<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9Z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.5 1.5 1.5 1.5 3M12 3c0 1.5 1.5 1.5 1.5 3"/></svg>
				</span>
				<span class="font-display text-xl font-bold tracking-tight"><?php bloginfo( 'name' ); ?></span>
			</a>

			<button type="button" id="primary-menu-toggle" class="md:hidden rounded-full border border-espresso/20 p-2" aria-label="<?php esc_attr_e( 'Toggle navigation', 'senja' ); ?>" aria-controls="primary-navigation" aria-expanded="false">
				<svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
			</button>

			<nav id="primary-navigation" class="hidden absolute inset-x-0 top-full border-b border-espresso/10 bg-cream md:static md:block md:border-0 md:bg-transparent" aria-label="<?php esc_attr_e( 'Primary', 'senja' ); ?>">
				<ul class="container flex flex-col gap-1 py-4 md:flex-row md:items-center md:gap-8 md:py-0 md:px-0">
					<?php foreach ( senja_nav_links() as $link ) : ?>
						<li>
							<a href="<?php echo esc_url( $link['url'] ); ?>" class="nav-link<?php echo $link['current'] ? ' is-current' : ''; ?>"<?php echo $link['current'] ? ' aria-current="page"' : ''; ?>><?php echo esc_html( $link['title'] ); ?></a>
						</li>
					<?php endforeach; ?>
					<li class="pt-2 md:pt-0">
						<a href="<?php echo esc_url( senja_page_url( 'contact' ) ); ?>" class="btn btn-primary"><?php esc_html_e( 'Visit us', 'senja' ); ?></a>
					</li>
				</ul>
			</nav>
		</div>
	</header>

	<div id="content" class="site-content grow">
		<main>
