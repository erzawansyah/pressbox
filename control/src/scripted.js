// Scripted mode: a stand-in for the LLM that replays fixed tool-call sequences, so the
// pipeline (sandbox, gate, apply) can be tested offline and in CI. Active only when no
// LLM_API_KEY is configured, and the UI labels it clearly. Never used for the demo video.

const RESERVATIONS_PHP = `<?php
/**
 * Table reservations: [senja_reservation_form] shortcode; bookings are stored as the
 * private "senja_reservation" post type and listed in wp-admin.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function senja_register_reservation_type() {
	register_post_type(
		'senja_reservation',
		array(
			'labels'    => array( 'name' => 'Reservations', 'singular_name' => 'Reservation' ),
			'public'    => false,
			'show_ui'   => true,
			'menu_icon' => 'dashicons-calendar-alt',
			'supports'  => array( 'title' ),
		)
	);
}
add_action( 'init', 'senja_register_reservation_type' );

function senja_handle_reservation() {
	if ( empty( $_POST['senja_reservation_nonce'] ) ) {
		return;
	}
	if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['senja_reservation_nonce'] ) ), 'senja_reservation' ) ) {
		$GLOBALS['senja_reservation_status'] = 'failed';
		return;
	}
	$name   = sanitize_text_field( wp_unslash( $_POST['senja_name'] ?? '' ) );
	$phone  = sanitize_text_field( wp_unslash( $_POST['senja_phone'] ?? '' ) );
	$date   = sanitize_text_field( wp_unslash( $_POST['senja_date'] ?? '' ) );
	$time   = sanitize_text_field( wp_unslash( $_POST['senja_time'] ?? '' ) );
	$guests = absint( $_POST['senja_guests'] ?? 0 );

	if ( '' === $name || '' === $phone || '' === $date || '' === $time || $guests < 1 ) {
		$GLOBALS['senja_reservation_status'] = 'incomplete';
		return;
	}

	$id = wp_insert_post(
		array(
			'post_type'   => 'senja_reservation',
			'post_status' => 'publish',
			'post_title'  => sprintf( '%s, %s %s, %d guests', $name, $date, $time, $guests ),
		)
	);
	if ( $id && ! is_wp_error( $id ) ) {
		update_post_meta( $id, 'senja_phone', $phone );
		$GLOBALS['senja_reservation_status'] = 'saved';
	} else {
		$GLOBALS['senja_reservation_status'] = 'failed';
	}
}
add_action( 'init', 'senja_handle_reservation', 20 );

/* DATE-HELPER-START */
function senja_format_date( $ymd ) {
	return wp_date( 'j F Y', strtotime( $ymd ) );
}
/* DATE-HELPER-END */

function senja_reservation_form_shortcode() {
	$status   = $GLOBALS['senja_reservation_status'] ?? '';
	$messages = array(
		'saved'      => 'Thank you! We received your reservation and will confirm on WhatsApp.',
		'incomplete' => 'Please fill in every field.',
		'failed'     => 'Sorry, the reservation could not be saved. Please try again.',
	);
	$today    = current_time( 'Y-m-d' );
	ob_start();
	?>
	<div class="senja-reservation">
		<?php if ( isset( $messages[ $status ] ) ) : ?>
			<p class="senja-reservation-message"><strong><?php echo esc_html( $messages[ $status ] ); ?></strong></p>
		<?php endif; ?>
		<p>Tables can be booked from <?php echo esc_html( senja_format_date( $today ) ); ?>.</p>
		<form method="post">
			<?php wp_nonce_field( 'senja_reservation', 'senja_reservation_nonce' ); ?>
			<p><label>Name<br><input type="text" name="senja_name" required></label></p>
			<p><label>WhatsApp number<br><input type="tel" name="senja_phone" required></label></p>
			<p><label>Date<br><input type="date" name="senja_date" min="<?php echo esc_attr( $today ); ?>" required></label></p>
			<p><label>Time<br><input type="time" name="senja_time" min="07:00" max="22:00" required></label></p>
			<p><label>Guests<br><input type="number" name="senja_guests" min="1" max="12" value="2" required></label></p>
			<p><button type="submit">Book a table</button></p>
		</form>
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode( 'senja_reservation_form', 'senja_reservation_form_shortcode' );
`;

// The first attempt "forgets" the date helper, producing a real fatal error in the sandbox
// so the error -> read log -> fix loop gets exercised.
const RESERVATIONS_FIRST_TRY = RESERVATIONS_PHP.replace(/\/\* DATE-HELPER-START \*\/[\s\S]*?\/\* DATE-HELPER-END \*\/\n\n/, '');
const RESERVATIONS_FIXED = RESERVATIONS_PHP.replace('/* DATE-HELPER-START */\n', '').replace('/* DATE-HELPER-END */\n', '');

const EXCHANGE_RATE_PHP = `<?php
/**
 * [senja_exchange_rate]: today's USD to IDR rate from a public API.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function senja_exchange_rate_shortcode() {
	$response = wp_remote_get( 'https://open.er-api.com/v6/latest/USD', array( 'timeout' => 5 ) );
	if ( is_wp_error( $response ) ) {
		return '<p class="senja-exchange-rate">Exchange rate unavailable.</p>';
	}
	$rates = json_decode( wp_remote_retrieve_body( $response ), true );
	$idr   = isset( $rates['rates']['IDR'] ) ? (float) $rates['rates']['IDR'] : 0;
	return '<p class="senja-exchange-rate">Today: 1 USD = IDR ' . esc_html( number_format( $idr, 0 ) ) . '</p>';
}
add_shortcode( 'senja_exchange_rate', 'senja_exchange_rate_shortcode' );
`;

const PROMO_PHP = `<?php
/**
 * [senja_promo]: bundle price that steps down until it is below IDR 20,000.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

function senja_promo_shortcode() {
	$regular  = 25000;
	$price    = $regular;
	$discount = 0;
	while ( $price >= 20000 ) {
		$discount = $discount + 0; // the step size was never set, so the loop never ends
		$price    = $regular - $discount;
	}
	return '<p class="senja-promo">Bundle price: IDR ' . esc_html( number_format( $price, 0 ) ) . '</p>';
}
add_shortcode( 'senja_promo', 'senja_promo_shortcode' );
`;

let callCounter = 0;
const toolCall = (name, args) => ({ id: `scripted_${++callCounter}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (content, calls) => ({ message: { role: 'assistant', content, tool_calls: calls }, usage: null });

function lastToolResult(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'tool');
  if (!last) return {};
  try {
    return JSON.parse(last.content);
  } catch {
    return {}; // truncated tool output; scenarios only need a few fields
  }
}

function pageIdBySlug(task, slug, fallbackId) {
  const page = (task.context?.pages || []).find((p) => p.post_name === slug);
  return String(page ? page.ID : fallbackId);
}

const MAIN_FILE = 'senja-coffee.php';
const withRequire = (main, file) => (main.includes(file) ? main : `${main.trimEnd()}\n\nrequire_once __DIR__ . '/includes/${file}';\n`);
const withShortcode = (content, tag) => `${content.trimEnd()}\n\n<!-- wp:shortcode -->\n[${tag}]\n<!-- /wp:shortcode -->`;

/**
 * Shared script for "add a shortcode feature to a page": read guide and main file, write
 * the feature, place it on the page, test, optionally fix once, finish.
 */
function featureScript(task, messages, step, scenario) {
  const state = (task.scriptState ??= {});
  const pageId = pageIdBySlug(task, scenario.pageSlug, scenario.fallbackPageId);
  switch (step) {
    case 0:
      return reply(scenario.intro, [toolCall('wp_guide', { doc: 'plugin-development/SKILL.md' }), toolCall('read_file', { path: MAIN_FILE })]);
    case 1:
      state.mainFile = lastToolResult(messages).content || '';
      return reply(null, [
        toolCall('write_file', { path: `includes/${scenario.file}`, content: scenario.code }),
        toolCall('write_file', { path: MAIN_FILE, content: withRequire(state.mainFile, scenario.file) }),
      ]);
    case 2:
      return reply(null, [toolCall('run_wp', { args: ['post', 'get', pageId, '--field=post_content'] })]);
    case 3:
      return reply(null, [toolCall('run_wp', { args: ['post', 'update', pageId, `--post_content=${withShortcode(lastToolResult(messages).stdout || '', scenario.tag)}`] })]);
    case 4:
      return reply(null, [toolCall('check_site', { path: `/?page_id=${pageId}` })]);
    case 5: {
      const check = lastToolResult(messages);
      const broken = check.critical_error_page || check.http_status >= 500 || check.php_lint_errors?.length || check.timed_out;
      // The first try is broken by design, so the fix is always written; the message reflects
      // whether this particular check already caught it, keeping the scenario deterministic.
      if (scenario.fixedCode) {
        const why = broken ? 'The page fails: the date helper was never defined.' : 'The date helper is still missing.';
        return reply(`${why} Adding it and testing again.`, [toolCall('write_file', { path: `includes/${scenario.file}`, content: scenario.fixedCode })]);
      }
      return reply(null, [toolCall('finish', { summary: scenario.summary(check) })]);
    }
    case 6:
      return reply(null, [toolCall('check_site', { path: `/?page_id=${pageId}` })]);
    default:
      return reply(null, [toolCall('finish', { summary: scenario.summary(lastToolResult(messages)) })]);
  }
}

const UI_PACING_MS = 600;

export async function scriptedCompletion(task, messages) {
  await new Promise((resolve) => setTimeout(resolve, UI_PACING_MS));
  const step = messages.filter((m) => m.role === 'assistant').length;
  const request = task.message.toLowerCase();

  if (/reservation|booking|book a table/.test(request)) {
    return featureScript(task, messages, step, {
      intro: 'I will build a table reservation form in the custom plugin and place it on the Contact page.',
      file: 'reservations.php',
      tag: 'senja_reservation_form',
      pageSlug: 'contact',
      fallbackPageId: 7,
      code: RESERVATIONS_FIRST_TRY,
      fixedCode: RESERVATIONS_FIXED,
      summary: () => 'A table reservation form is now on the Contact page. Guests enter name, WhatsApp number, date, time and party size; bookings appear under "Reservations" in wp-admin.',
    });
  }
  if (/exchange rate|currency|external api|dollar/.test(request)) {
    return featureScript(task, messages, step, {
      intro: 'I will build an exchange-rate widget that reads a public API and place it on the Home page.',
      file: 'exchange-rate.php',
      tag: 'senja_exchange_rate',
      pageSlug: 'home',
      fallbackPageId: 4,
      code: EXCHANGE_RATE_PHP,
      summary: () => 'The exchange-rate widget is built, but it needs an external service (open.er-api.com) that the sandbox cannot reach. That domain must be approved before this feature can ship.',
    });
  }
  if (/promo|discount|bundle/.test(request)) {
    return featureScript(task, messages, step, {
      intro: 'I will add a bundle promo banner to the Home page.',
      file: 'promo.php',
      tag: 'senja_promo',
      pageSlug: 'home',
      fallbackPageId: 4,
      code: PROMO_PHP,
      summary: (check) =>
        check.timed_out || check.critical_error_page
          ? 'The promo banner is built, but the Home page stopped at the time limit in the sandbox. The price calculation needs fixing.'
          : 'The promo banner is on the Home page.',
    });
  }
  const quoted = task.message.match(/["“](.+?)["”]/);
  if (/tagline|slogan/.test(request) && quoted) {
    if (step === 0) return reply('Updating the site tagline.', [toolCall('run_wp', { args: ['option', 'update', 'blogdescription', quoted[1]] })]);
    if (step === 1) return reply(null, [toolCall('check_site', { path: '/' })]);
    return reply(null, [toolCall('finish', { summary: `The site tagline is now "${quoted[1]}".` })]);
  }
  return reply(null, [
    toolCall('finish', {
      summary: 'Scripted mode only knows the example requests: reservation form, exchange-rate widget (external API), promo banner, and change the tagline to "...". Set LLM_API_KEY (Vultr Serverless Inference) for free-form requests.',
    }),
  ]);
}
