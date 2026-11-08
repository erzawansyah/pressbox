<?php
/**
 * Site footer: where to find the café, plus the theme credit.
 */
?>
		</main>
	</div>

	<footer class="mt-24 bg-espresso text-cream/80" role="contentinfo">
		<div class="container grid gap-10 py-16 md:grid-cols-3">
			<div>
				<p class="font-display text-2xl font-bold text-cream"><?php bloginfo( 'name' ); ?></p>
				<p class="mt-3 max-w-xs"><?php bloginfo( 'description' ); ?></p>
			</div>
			<div>
				<p class="eyebrow text-dusk-light"><?php esc_html_e( 'Find us', 'senja' ); ?></p>
				<p class="mt-3">Jl. Kenanga 17, Malang<br>WhatsApp +62 812 0000 1717</p>
			</div>
			<div>
				<p class="eyebrow text-dusk-light"><?php esc_html_e( 'Open daily', 'senja' ); ?></p>
				<p class="mt-3">Mon–Fri 07:00–22:00<br>Sat 08:00–23:00 · Sun 08:00–21:00</p>
			</div>
		</div>
		<div class="border-t border-cream/10">
			<p class="container py-6 text-sm text-cream/50">&copy; <?php echo esc_html( date_i18n( 'Y' ) ); ?> <?php bloginfo( 'name' ); ?></p>
		</div>
	</footer>
</div>
<?php wp_footer(); ?>
</body>
</html>
