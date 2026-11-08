// Unit tests for the policies that keep the agent contained. Run: npm test (in control/).
// Fixtures use neutral arguments ($code, $cmd); the gate matches function names, not payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.LLM_API_KEY = 'operator-key-for-tests';
process.env.JUDGE_ACCESS_CODE = 'judge-code-for-tests';
process.env.JUDGE_TASK_LIMIT = '2';

const { safePluginPath, checkWpArgs, parseObserverLog } = await import('../src/tools.js');
const { scanChangedCode, isCoreHost } = await import('../src/gate.js');
const { openSession, authorizeTask, describeSession, getSession } = await import('../src/access.js');

test('plugin paths stay inside the custom plugin', () => {
  assert.equal(safePluginPath('includes/reservations.php'), 'includes/reservations.php');
  assert.equal(safePluginPath('./senja-coffee.php'), 'senja-coffee.php');
  assert.equal(safePluginPath('includes\\style.css'), 'includes/style.css');
  for (const escape of ['../wp-config.php', 'includes/../../wp-config.php', '/etc/passwd', '..', '']) {
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
  assert.throws(() => checkWpArgs(['eval', 'echo 1;']), /not allowed/);
  assert.throws(() => checkWpArgs(['db', 'export']), /not allowed/);
  assert.throws(() => checkWpArgs(['config', 'get']), /not allowed/);
  assert.throws(() => checkWpArgs(['post', 'list', '--exec=echo 1']), /Flag not allowed/);
  assert.throws(() => checkWpArgs(['post', 'list', '--require=extra.php']), /Flag not allowed/);
  assert.throws(() => checkWpArgs(['option', 'update', 'siteurl', 'http://other.example']), /protected/);
  assert.throws(() => checkWpArgs(['option', 'update', 'senja_smtp_password', 'x']), /protected/);
  assert.throws(() => checkWpArgs([]), /array/);
});

test('static scan flags dangerous calls, outbound hosts and extension needs', () => {
  const clean = scanChangedCode({ 'a.php': { after: "<?php echo esc_html( get_bloginfo( 'name' ) );" } });
  assert.deepEqual(clean, { dangerous: [], calledHosts: [], neededExtensions: [] });

  const risky = scanChangedCode({
    'risky.php': { after: '<?php eval( $code ); shell_exec( $cmd ); $raw = base64_decode( $blob ); wp_insert_user( $fields );' },
    'net.php': { after: "<?php wp_remote_get( 'https://api.example.com/v1/rates' ); $fmt = new NumberFormatter( 'id', 1 );" },
  });
  assert.equal(risky.dangerous.length, 4);
  assert.deepEqual(risky.calledHosts, ['api.example.com']);
  assert.deepEqual(risky.neededExtensions, ['intl']);

  // `curl_exec` must not be mistaken for `exec(`; it is flagged as raw network access instead.
  const curl = scanChangedCode({ 'c.php': { after: '<?php curl_exec( $handle );' } });
  assert.deepEqual(curl.dangerous, ['c.php: raw network access']);
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

test('judge code unlocks a shared quota; own keys stay per session', () => {
  assert.throws(() => openSession({ code: 'wrong' }), /not valid/);
  assert.throws(() => openSession({}), /access code/);
  assert.throws(() => authorizeTask('no-such-session'), /Unlock/);

  const judge = openSession({ code: 'judge-code-for-tests' });
  assert.equal(judge.kind, 'judge');
  assert.equal(authorizeTask(judge.token), 'operator-key-for-tests');
  assert.equal(authorizeTask(judge.token), 'operator-key-for-tests');
  assert.throws(() => authorizeTask(judge.token), /quota/);
  assert.equal(describeSession(getSession(judge.token)).remaining, 0);

  assert.throws(() => openSession({ apiKey: 'short' }), /API key/);
  const own = openSession({ apiKey: 'VISITOR0OWN0KEY0ABCDEFGHIJKLMNOP' });
  assert.equal(own.kind, 'own-key');
  assert.equal(own.apiKey, undefined, 'the key must never be echoed back to the browser');
  assert.equal(authorizeTask(own.token), 'VISITOR0OWN0KEY0ABCDEFGHIJKLMNOP');
});
