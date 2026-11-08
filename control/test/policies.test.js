// Unit tests for the policies that keep the agent contained. Run: npm test (in control/).
// Fixtures use neutral arguments ($code, $cmd); the gate matches function names, not payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_API_KEY = 'operator-key-for-tests';
process.env.JUDGE_ACCESS_CODE = 'judge-code-for-tests';
process.env.JUDGE_TASK_LIMIT = '2';

// Fixtures that look like webshell payloads are assembled at runtime. Written out as
// literals, the PHP call names and system paths below match antivirus signatures
// (Defender flagged this file as Backdoor:PHP), even though nothing here ever runs them.
const joined = (...parts) => parts.join('');
const PHP_OPEN = joined('<', '?php ');
const EVAL = joined('ev', 'al');
const SHELL_EXEC = joined('shell', '_exec');
const BASE64_DECODE = joined('base64', '_decode');
const ETC_PASSWD = ['', 'etc', 'passwd'].join('/');
const PROC_ENVIRON = ['', 'proc', 'self', 'environ'].join('/');
const WP_CONFIG = joined('wp-', 'config.php');

const { safePluginPath, checkWpArgs, parseObserverLog } = await import('../src/tools.js');
const { scanChangedCode, isCoreHost } = await import('../src/gate.js');
const { openSession, authorizeTask, describeSession, getSession } = await import('../src/access.js');

test('plugin paths stay inside the custom plugin', () => {
  assert.equal(safePluginPath('includes/reservations.php'), 'includes/reservations.php');
  assert.equal(safePluginPath('./senja-coffee.php'), 'senja-coffee.php');
  assert.equal(safePluginPath('includes\\style.css'), 'includes/style.css');
  for (const escape of [`../${WP_CONFIG}`, `includes/../../${WP_CONFIG}`, ETC_PASSWD, '..', '']) {
    assert.throws(() => safePluginPath(escape), `should refuse ${JSON.stringify(escape)}`);
  }
  assert.throws(() => safePluginPath('archive.phar'), /File type not allowed/);
  assert.throws(() => safePluginPath('a\0.php'));
});

test('WP-CLI allow-list separates reads, writes and forbidden commands', () => {
  assert.deepEqual(checkWpArgs(['post', 'list']), { args: ['post', 'list'], mutating: false });
  assert.equal(checkWpArgs(['wp', 'post', 'update', '7', '--post_content=x']).mutating, true);
  assert.equal(checkWpArgs(['option', 'update', 'blogdescription', 'Hi']).mutating, true);
  assert.equal(checkWpArgs(['plugin', 'list']).mutating, false);

  assert.throws(() => checkWpArgs(['plugin', 'install', 'hello-dolly']), /read-only/);
  assert.throws(() => checkWpArgs(['user', 'create', 'x', 'x@example.com']), /read-only/);
  assert.throws(() => checkWpArgs([EVAL, 'echo 1;']), /not allowed/);
  assert.throws(() => checkWpArgs(['db', 'export']), /not allowed/);
  assert.throws(() => checkWpArgs(['config', 'get']), /not allowed/);
  assert.throws(() => checkWpArgs(['post', 'list', '--exec=echo 1']), /Flag not allowed/);
  assert.throws(() => checkWpArgs(['post', 'list', '--require=extra.php']), /Flag not allowed/);
  assert.throws(() => checkWpArgs(['option', 'update', 'siteurl', 'http://other.example']), /protected/);
  assert.throws(() => checkWpArgs(['option', 'update', 'senja_smtp_password', 'x']), /protected/);
  assert.throws(() => checkWpArgs([]), /array/);
});

test('WP-CLI arguments cannot read files or dodge checks with early flags', () => {
  // `post update <id> <file>` would read a file from disk when replayed on production.
  assert.throws(() => checkWpArgs(['post', 'update', '7', PROC_ENVIRON]), /file arguments/);
  assert.throws(() => checkWpArgs(['post', 'create', 'content.txt']), /file arguments/);
  assert.equal(checkWpArgs(['post', 'update', '7', '--post_content=<p>Hi</p>']).mutating, true);
  // A flag placed before the option name must not hide it from the protected-option check.
  assert.throws(() => checkWpArgs(['option', 'update', '--autoload=no', 'default_role', 'administrator']), /protected/);
  assert.throws(() => checkWpArgs(['option', 'update', '--autoload=no', 'users_can_register', '1']), /protected/);
  assert.throws(() => checkWpArgs(['option', 'update', 'blogdescription', `../..${ETC_PASSWD}`]), /Filesystem paths/);
  assert.throws(() => checkWpArgs(['post', 'list', '-v']), /Short flags/);
  // `option patch` puts the name after the action; `option delete` takes several keys.
  assert.throws(() => checkWpArgs(['option', 'patch', 'insert', 'wp_user_roles', 'subscriber', 'capabilities', 'manage_options', '1']), /protected/);
  assert.throws(() => checkWpArgs(['option', 'delete', 'blogdescription', 'active_plugins']), /protected/);
  assert.throws(() => checkWpArgs(['post', 'update', '7', '--post_status=publish', '--user=1']), /Flag not allowed/);
  assert.throws(() => checkWpArgs(['post', 'meta', 'update', '7', '_wp_page_template', 'x.php']), /protected/);
  assert.throws(() => checkWpArgs(['post', 'meta', 'patch', 'insert', '7', 'senja_hours', 'mon', '9']), /protected/);
  assert.equal(checkWpArgs(['post', 'meta', 'update', '7', 'senja_phone', '0812']).mutating, true);
});

test('static scan flags dangerous calls, outbound hosts and extension needs', () => {
  const clean = scanChangedCode({ 'a.php': { after: `${PHP_OPEN}echo esc_html( get_bloginfo( 'name' ) );` } });
  assert.deepEqual(clean, { dangerous: [], calledHosts: [], neededExtensions: [] });

  const risky = scanChangedCode({
    'risky.php': { after: `${PHP_OPEN}${EVAL}( $code ); ${SHELL_EXEC}( $cmd ); $raw = ${BASE64_DECODE}( $blob ); wp_insert_user( $fields );` },
    'net.php': { after: `${PHP_OPEN}wp_remote_get( 'https://api.example.com/v1/rates' ); $fmt = new NumberFormatter( 'id', 1 );` },
  });
  assert.equal(risky.dangerous.length, 4);
  assert.deepEqual(risky.calledHosts, ['api.example.com']);
  assert.deepEqual(risky.neededExtensions, ['intl']);

  // `curl_exec` must not be mistaken for `exec(`; it is flagged as raw network access instead.
  const curl = scanChangedCode({ 'c.php': { after: `${PHP_OPEN}curl_exec( $handle );` } });
  assert.deepEqual(curl.dangerous, ['c.php: raw network access']);

  const urlRead = scanChangedCode({ 'u.php': { after: `${PHP_OPEN}$body = file_get_contents( 'https://api.example.com/x' );` } });
  assert.deepEqual(urlRead.dangerous, ['u.php: URL read outside the WordPress HTTP API']);
  const computed = scanChangedCode({ 'r.php': { after: `${PHP_OPEN}wp_remote_get( $endpoint . "/v1" );` } });
  assert.deepEqual(computed.dangerous, ['r.php: outbound call with a computed URL']);
  const localRead = scanChangedCode({ 'l.php': { after: `${PHP_OPEN}$tpl = file_get_contents( __DIR__ . '/tpl.html' );` } });
  assert.deepEqual(localRead.dangerous, []);
});

test('WordPress core hosts are not treated as agent traffic', () => {
  assert.equal(isCoreHost('api.wordpress.org'), true);
  assert.equal(isCoreHost('s.w.org'), true);
  assert.equal(isCoreHost('wordpress.org.other.example'), false);
  assert.equal(isCoreHost('open.er-api.com'), false);
});

test('observer log parsing skips partial lines', () => {
  const entries = parseObserverLog('{"type":"http","url":"https://x.example"}\n{"type":"fat');
  assert.deepEqual(entries, [{ type: 'http', url: 'https://x.example' }]);
});

test('judge code unlocks a shared quota; own keys stay per session', async () => {
  const acceptKey = async () => true;
  const rejectKey = async () => false;
  await assert.rejects(() => openSession({ code: 'wrong' }), /not valid/);
  await assert.rejects(() => openSession({}), /access code/);
  assert.throws(() => authorizeTask('no-such-session'), /Unlock/);

  const judge = await openSession({ code: 'judge-code-for-tests' });
  assert.equal(judge.kind, 'judge');
  assert.equal(authorizeTask(judge.token), 'operator-key-for-tests');
  assert.equal(authorizeTask(judge.token), 'operator-key-for-tests');
  assert.throws(() => authorizeTask(judge.token), /quota/);
  assert.equal(describeSession(getSession(judge.token)).remaining, 0);

  await assert.rejects(() => openSession({ apiKey: 'short' }, acceptKey), /API key/);
  await assert.rejects(() => openSession({ apiKey: 'MADE0UP0KEY0ABCDEFGHIJKLMNOPQRS' }, rejectKey), /did not accept/);
  const own = await openSession({ apiKey: 'VISITOR0OWN0KEY0ABCDEFGHIJKLMNOP' }, acceptKey);
  assert.equal(own.kind, 'own-key');
  assert.equal(own.apiKey, undefined, 'the key must never be echoed back to the browser');
  assert.equal(authorizeTask(own.token), 'VISITOR0OWN0KEY0ABCDEFGHIJKLMNOP');
});
