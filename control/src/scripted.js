// SCRIPTED MODE: a fake LLM that replays fixed tool-call sequences.
// Only for testing the pipeline before a Vultr Serverless Inference key is available.
// The UI shows a "MODE SKRIP" banner whenever this is active. Never use it for the submission video.

const RESERVASI_FIXED = `<?php
/**
 * Form reservasi meja: shortcode [kss_reservasi], data tersimpan sebagai post type "kss_reservasi".
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function kss_reservasi_register_post_type() {
	register_post_type(
		'kss_reservasi',
		array(
			'labels'    => array( 'name' => 'Reservasi', 'singular_name' => 'Reservasi' ),
			'public'    => false,
			'show_ui'   => true,
			'menu_icon' => 'dashicons-calendar-alt',
			'supports'  => array( 'title' ),
		)
	);
}
add_action( 'init', 'kss_reservasi_register_post_type' );

function kss_reservasi_handle_submit() {
	if ( empty( $_POST['kss_reservasi_nonce'] ) ) {
		return;
	}
	if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['kss_reservasi_nonce'] ) ), 'kss_reservasi' ) ) {
		$GLOBALS['kss_reservasi_status'] = 'gagal';
		return;
	}
	$nama    = sanitize_text_field( wp_unslash( $_POST['kss_nama'] ?? '' ) );
	$wa      = sanitize_text_field( wp_unslash( $_POST['kss_wa'] ?? '' ) );
	$tanggal = sanitize_text_field( wp_unslash( $_POST['kss_tanggal'] ?? '' ) );
	$jam     = sanitize_text_field( wp_unslash( $_POST['kss_jam'] ?? '' ) );
	$orang   = absint( $_POST['kss_orang'] ?? 0 );

	if ( '' === $nama || '' === $wa || '' === $tanggal || '' === $jam || $orang < 1 ) {
		$GLOBALS['kss_reservasi_status'] = 'kurang';
		return;
	}

	$id = wp_insert_post(
		array(
			'post_type'   => 'kss_reservasi',
			'post_status' => 'publish',
			'post_title'  => sprintf( '%s, %s %s, %d orang', $nama, $tanggal, $jam, $orang ),
		)
	);
	if ( $id && ! is_wp_error( $id ) ) {
		update_post_meta( $id, 'kss_wa', $wa );
		$GLOBALS['kss_reservasi_status'] = 'ok';
	} else {
		$GLOBALS['kss_reservasi_status'] = 'gagal';
	}
}
add_action( 'init', 'kss_reservasi_handle_submit', 20 );

/* HELPER-START */
function kss_format_tanggal_indonesia( $ymd ) {
	$bulan = array( 1 => 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember' );
	$t     = strtotime( $ymd );
	return (int) gmdate( 'j', $t ) . ' ' . $bulan[ (int) gmdate( 'n', $t ) ] . ' ' . gmdate( 'Y', $t );
}
/* HELPER-END */

function kss_reservasi_shortcode() {
	$status   = $GLOBALS['kss_reservasi_status'] ?? '';
	$pesan    = array(
		'ok'     => 'Terima kasih! Reservasi kamu sudah kami terima. Kami konfirmasi lewat WhatsApp.',
		'kurang' => 'Mohon lengkapi semua kolom.',
		'gagal'  => 'Maaf, reservasi gagal disimpan. Coba lagi.',
	);
	$hari_ini = current_time( 'Y-m-d' );
	ob_start();
	?>
	<div class="kss-reservasi">
		<?php if ( isset( $pesan[ $status ] ) ) : ?>
			<p class="kss-reservasi-pesan"><strong><?php echo esc_html( $pesan[ $status ] ); ?></strong></p>
		<?php endif; ?>
		<p>Reservasi meja tersedia mulai <?php echo esc_html( kss_format_tanggal_indonesia( $hari_ini ) ); ?>.</p>
		<form method="post">
			<?php wp_nonce_field( 'kss_reservasi', 'kss_reservasi_nonce' ); ?>
			<p><label>Nama<br><input type="text" name="kss_nama" required></label></p>
			<p><label>Nomor WhatsApp<br><input type="tel" name="kss_wa" required></label></p>
			<p><label>Tanggal<br><input type="date" name="kss_tanggal" min="<?php echo esc_attr( $hari_ini ); ?>" required></label></p>
			<p><label>Jam<br><input type="time" name="kss_jam" min="07:00" max="22:00" required></label></p>
			<p><label>Jumlah orang<br><input type="number" name="kss_orang" min="1" max="12" value="2" required></label></p>
			<p><button type="submit">Pesan meja</button></p>
		</form>
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode( 'kss_reservasi', 'kss_reservasi_shortcode' );
`;

// First attempt "forgets" the date helper -> fatal error in the sandbox -> the loop fixes it.
const RESERVASI_BUGGY = RESERVASI_FIXED.replace(/\/\* HELPER-START \*\/[\s\S]*?\/\* HELPER-END \*\/\n\n/, '');
const RESERVASI_CLEAN = RESERVASI_FIXED.replace('/* HELPER-START */\n', '').replace('/* HELPER-END */\n', '');

const KURS = `<?php
/**
 * Widget kurs: shortcode [kss_kurs] menampilkan kurs USD ke IDR dari API publik.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function kss_kurs_shortcode() {
	$res = wp_remote_get( 'https://open.er-api.com/v6/latest/USD', array( 'timeout' => 5 ) );
	if ( is_wp_error( $res ) ) {
		return '<p class="kss-kurs">Kurs belum bisa dimuat.</p>';
	}
	$data = json_decode( wp_remote_retrieve_body( $res ), true );
	$idr  = isset( $data['rates']['IDR'] ) ? (float) $data['rates']['IDR'] : 0;
	return '<p class="kss-kurs">Kurs hari ini: 1 USD = Rp' . esc_html( number_format( $idr, 0, ',', '.' ) ) . '</p>';
}
add_shortcode( 'kss_kurs', 'kss_kurs_shortcode' );
`;

const PROMO = `<?php
/**
 * Banner promo: shortcode [kss_promo] menghitung harga promo paket kopi.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function kss_promo_shortcode() {
	$harga_normal = 25000;
	$harga        = $harga_normal;
	$diskon       = 0;
	// Turunkan harga bertahap sampai di bawah Rp20.000.
	while ( $harga >= 20000 ) {
		$diskon = $diskon + 0; // langkah diskon lupa diisi: loop tidak pernah berhenti
		$harga  = $harga_normal - $diskon;
	}
	return '<p class="kss-promo">Promo paket: Rp' . esc_html( number_format( $harga, 0, ',', '.' ) ) . '</p>';
}
add_shortcode( 'kss_promo', 'kss_promo_shortcode' );
`;

let seq = 0;
const call = (name, args) => ({ id: `scr_${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content, calls) => ({ message: { role: 'assistant', content, tool_calls: calls }, usage: null });

function lastToolJson(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      try {
        return JSON.parse(messages[i].content);
      } catch {
        return {};
      }
    }
  }
  return {};
}

function pageId(task, slug, fallback) {
  const p = (task.context?.pages || []).find((x) => x.post_name === slug);
  return String(p ? p.ID : fallback);
}

const withRequire = (main, file) =>
  main.includes(file) ? main : `${main.trimEnd()}\n\nrequire_once __DIR__ . '/includes/${file}';\n`;
const withShortcode = (content, tag) => `${content.trimEnd()}\n\n<!-- wp:shortcode -->\n[${tag}]\n<!-- /wp:shortcode -->`;

function featureScenario(task, messages, step, o) {
  const st = (task.scripted = task.scripted || {});
  const pid = pageId(task, o.pageSlug, o.pageFallback);
  switch (step) {
    case 0:
      return say(o.intro, [call('wp_guide', { doc: 'plugin-development/SKILL.md' }), call('read_file', { path: 'kedai-senja-custom.php' })]);
    case 1:
      st.main = lastToolJson(messages).content || '';
      return say(null, [
        call('write_file', { path: `includes/${o.file}`, content: o.firstCode }),
        call('write_file', { path: 'kedai-senja-custom.php', content: withRequire(st.main, o.file) }),
      ]);
    case 2:
      return say(null, [call('run_wp', { args: ['post', 'get', pid, '--field=post_content'] })]);
    case 3:
      st.page = lastToolJson(messages).stdout || '';
      return say(null, [call('run_wp', { args: ['post', 'update', pid, `--post_content=${withShortcode(st.page, o.tag)}`] })]);
    case 4:
      return say(null, [call('check_site', { path: `/?page_id=${pid}` })]);
    case 5: {
      const r = lastToolJson(messages);
      const broken = r.critical_error_page || r.http_status >= 500 || (r.php_lint_errors || []).length || r.timed_out;
      if (broken && o.fixCode) {
        st.fixed = true;
        return say('Halaman error: fungsi pembantu tanggal belum dibuat. Saya tambahkan lalu uji ulang.', [
          call('write_file', { path: `includes/${o.file}`, content: o.fixCode }),
        ]);
      }
      return say(null, [call('finish', { summary: o.summary(r) })]);
    }
    case 6:
      return say(null, [call('check_site', { path: `/?page_id=${pid}` })]);
    default:
      return say(null, [call('finish', { summary: o.summary(lastToolJson(messages)) })]);
  }
}

export async function scriptedCompletion(task, messages) {
  await new Promise((r) => setTimeout(r, 600)); // pacing so the UI feed is readable
  const step = messages.filter((m) => m.role === 'assistant').length;
  const msg = task.message.toLowerCase();

  if (/reservasi|booking|pesan meja/.test(msg)) {
    return featureScenario(task, messages, step, {
      intro: 'Saya buat form reservasi meja di plugin kustom, lalu pasang di halaman Kontak.',
      file: 'reservasi.php',
      tag: 'kss_reservasi',
      pageSlug: 'kontak',
      pageFallback: 7,
      firstCode: RESERVASI_BUGGY,
      fixCode: RESERVASI_CLEAN,
      summary: () =>
        'Form reservasi meja sudah ditambahkan di halaman Kontak. Pengunjung mengisi nama, WhatsApp, tanggal, jam, dan jumlah orang. Data reservasi masuk ke menu "Reservasi" di wp-admin.',
    });
  }
  if (/kurs|cuaca|api luar|dolar|exchange/.test(msg)) {
    return featureScenario(task, messages, step, {
      intro: 'Saya buat widget kurs yang mengambil data dari API publik, lalu pasang di Beranda.',
      file: 'kurs.php',
      tag: 'kss_kurs',
      pageSlug: 'beranda',
      pageFallback: 4,
      firstCode: KURS,
      summary: () =>
        'Widget kurs sudah dibuat, tapi datanya berasal dari layanan luar (open.er-api.com). Di sandbox koneksi itu tertahan karena sandbox tidak punya akses internet. Domain ini perlu disetujui dulu sebelum fitur bisa dipakai.',
    });
  }
  if (/promo|diskon/.test(msg)) {
    return featureScenario(task, messages, step, {
      intro: 'Saya buat banner promo paket kopi dan pasang di Beranda.',
      file: 'promo.php',
      tag: 'kss_promo',
      pageSlug: 'beranda',
      pageFallback: 4,
      firstCode: PROMO,
      summary: (r) =>
        r.timed_out || r.critical_error_page
          ? 'Banner promo sudah dibuat, tapi halaman Beranda di sandbox berhenti karena melewati batas waktu. Perhitungan promonya perlu diperbaiki.'
          : 'Banner promo sudah dipasang di Beranda.',
    });
  }
  const tagline = task.message.match(/["“](.+?)["”]/);
  if (/tagline|slogan/.test(msg) && tagline) {
    if (step === 0) return say('Saya ganti tagline situs.', [call('run_wp', { args: ['option', 'update', 'blogdescription', tagline[1]] })]);
    if (step === 1) return say(null, [call('check_site', { path: '/' })]);
    return say(null, [call('finish', { summary: `Tagline situs sekarang: "${tagline[1]}".` })]);
  }
  return say(null, [
    call('finish', {
      summary:
        'Mode skrip hanya mendukung contoh: form reservasi, widget kurs (API luar), banner promo, dan ganti tagline "...". Isi LLM_API_KEY (Vultr Serverless Inference) untuk permintaan bebas.',
    }),
  ]);
}
