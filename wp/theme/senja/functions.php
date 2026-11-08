<?php
/**
 * Senja theme bootstrap. TailPress wires the Vite build (dist/) and theme supports;
 * everything site-specific (features, shortcodes, forms) lives in the senja-coffee plugin.
 */

if ( is_file( __DIR__ . '/vendor/autoload_packages.php' ) ) {
	require_once __DIR__ . '/vendor/autoload_packages.php';
}

function tailpress(): TailPress\Framework\Theme {
	return TailPress\Framework\Theme::instance()
		->assets(
			fn( $manager ) => $manager
				->withCompiler(
					new TailPress\Framework\Assets\ViteCompiler(),
					fn( $compiler ) => $compiler
						->registerAsset( 'resources/css/app.css' )
						->registerAsset( 'resources/js/app.js' )
						->editorStyleFile( 'resources/css/editor-style.css' )
				)
				->enqueueAssets()
		)
		// A plain label: translating it here would load the text domain before init.
		->menus( fn( $manager ) => $manager->add( 'primary', 'Primary Menu' ) )
		->themeSupport( fn( $manager ) => $manager->add( array( 'title-tag', 'align-wide', 'responsive-embeds', 'html5' => array( 'search-form', 'gallery', 'caption' ) ) ) );
}

tailpress();

add_action(
	'wp_enqueue_scripts',
	function () {
		wp_enqueue_style( 'senja-fonts', 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600&display=swap', array(), null );
	}
);

/**
 * Navigation links: the primary menu if the owner set one, otherwise the published
 * pages in menu order, so a fresh site still gets a working header.
 *
 * @return array<int, array{title: string, url: string, current: bool}>
 */
function senja_nav_links(): array {
	$current = get_queried_object_id();
	$pages   = get_pages( array( 'sort_column' => 'menu_order', 'parent' => 0 ) );

	return array_map(
		fn( $page ) => array(
			'title'   => get_the_title( $page ),
			'url'     => get_permalink( $page ),
			'current' => (int) $page->ID === (int) $current,
		),
		$pages
	);
}

/**
 * Contact page URL for the call-to-action buttons, found by slug so it survives ID changes.
 */
function senja_page_url( string $slug ): string {
	$page = get_page_by_path( $slug );
	return $page ? get_permalink( $page ) : home_url( '/' );
}
