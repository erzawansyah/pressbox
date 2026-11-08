// Deterministic gate. The model never decides whether its own work is safe to ship;
// these checks do, and every one of them must pass before "Apply to production" appears.
import { cfg } from './config.js';
import { sandboxExec, sandboxHttp, lintPlugin, readSandboxFile, wasOomKilled } from './sandbox.js';
import { parseObserverLog } from './tools.js';
import { isCriticalPage } from './proc.js';

const DANGEROUS_PATTERNS = [
  [/\b(eval|assert)\s*\(/, 'eval/assert'],
  [/\b(exec|shell_exec|system|passthru|proc_open|popen|pcntl_exec)\s*\(/, 'runs system commands'],
  [/`[^`\n]*\$[^`\n]*`/, 'shell backticks'],
  [/\b(fsockopen|pfsockopen|stream_socket_client|curl_init|curl_exec|curl_multi_exec)\s*\(/, 'raw network access'],
  [/\b(file_get_contents|fopen|file|readfile|get_headers)\s*\(\s*['"](https?|ftp):\/\//, 'URL read outside the WordPress HTTP API'],
  [/\b(wp_insert_user|wp_create_user|wp_update_user|add_role|set_role)\s*\(/, 'changes user accounts or roles'],
  [/\b(base64_decode|gzinflate|str_rot13)\s*\(/, 'obfuscated code'],
  [/\$wpdb\s*->\s*query\s*\(/, 'raw SQL'],
  [/\b(file_put_contents|unlink|rename)\s*\(\s*ABSPATH/, 'writes or deletes core files'],
];

// Code that needs a PHP extension production lacks would fatal there even if the sandbox had it.
const EXTENSION_USAGE = {
  imagick: /\bImagick\w*\b/,
  gd: /\bimage(create|copy|png|jpeg|webp)\w*\s*\(/,
  intl: /\b(NumberFormatter|IntlDateFormatter|Collator|Normalizer)\b/,
  mbstring: /\bmb_\w+\s*\(/,
  zip: /\bZipArchive\b/,
  curl: /\bcurl_\w+\s*\(/,
  sodium: /\bsodium_\w+\s*\(/,
  exif: /\bexif_\w+\s*\(/,
};

// WordPress core's own update and pattern checks are not agent code.
export const isCoreHost = (host) => /(^|\.)(wordpress\.org|w\.org)$/i.test(host);

const hostname = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url; // not a URL; compare the raw string
  }
};
const isApprovedHost = (host) => cfg.allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Static analysis of every file the agent wrote: dangerous calls, hard-coded outbound
 * hosts, and PHP extensions the code depends on. Pure, so it is unit-tested directly.
 */
export function scanChangedCode(files) {
  const dangerous = [];
  const calledHosts = new Set();
  const neededExtensions = new Set();
  for (const [file, { after: code }] of Object.entries(files)) {
    for (const [pattern, label] of DANGEROUS_PATTERNS) if (pattern.test(code)) dangerous.push(`${file}: ${label}`);
    for (const match of code.matchAll(/wp_(?:safe_)?remote_(?:get|post|request|head)\s*\(\s*['"]([^'"]+)['"]/g)) calledHosts.add(hostname(match[1]));
    // A URL built at runtime cannot be checked against the approved domains, so it is refused.
    if (/\bwp_(?:safe_)?remote_(?:get|post|request|head)\s*\(\s*[^'"\s]/.test(code)) dangerous.push(`${file}: outbound call with a computed URL`);
    for (const [extension, pattern] of Object.entries(EXTENSION_USAGE)) if (pattern.test(code)) neededExtensions.add(extension);
  }
  return { dangerous, calledHosts: [...calledHosts], neededExtensions: [...neededExtensions] };
}

async function administratorLogins(task) {
  const res = await sandboxExec(task, ['wp', 'user', 'list', '--role=administrator', '--field=user_login']);
  return res.stdout.split('\n').filter(Boolean).sort().join(',');
}

export async function recordBaseline(task) {
  task.adminsBefore = await administratorLogins(task);
}

export async function runGate(task, agentOutcome) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  check('Agent finished the task', agentOutcome.finished, agentOutcome.finished ? 'The agent called finish.' : `Did not finish: ${agentOutcome.reason}.`);

  const files = Object.keys(task.changeset.files);
  const commandCount = task.changeset.commands.length;
  check('There is a change to review', files.length + commandCount > 0, `${files.length} plugin files, ${commandCount} WP-CLI commands.`);

  const lintErrors = await lintPlugin(task);
  check('Plugin PHP syntax is valid', lintErrors.length === 0, lintErrors.length ? lintErrors.join(' | ').slice(0, 400) : 'php -l is clean for every file.');

  const { dangerous, calledHosts, neededExtensions } = scanChangedCode(task.changeset.files);
  check('No dangerous functions in the code', dangerous.length === 0, dangerous.length ? dangerous.join('; ') : 'Pattern scan is clean.');

  const unapprovedHosts = calledHosts.filter((host) => !isApprovedHost(host));
  check(
    'Only approved outbound domains',
    unapprovedHosts.length === 0,
    unapprovedHosts.length ? `The code calls domains nobody approved: ${unapprovedHosts.join(', ')}.` : 'The code calls no external services.',
  );

  if (task.profile) {
    const missing = neededExtensions.filter((extension) => task.profile.missing_extensions.includes(extension));
    check(
      'Compatible with the production server',
      missing.length === 0,
      missing.length
        ? `The code needs PHP extensions production does not have: ${missing.join(', ')}.`
        : `Uses only extensions available on production (PHP ${task.profile.php_version}).`,
    );
  }

  // Judge the final state only: errors the agent hit and already fixed must not count,
  // so we look at what the logs gain while the gate re-renders every page itself.
  const debugOffset = (await readSandboxFile(task, '/tmp/wp-debug.log')).length;
  const observerOffset = (await readSandboxFile(task, '/tmp/pb-observer.log')).length;

  const pageIds = (await sandboxExec(task, ['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--field=ID'])).stdout.split('\n').filter(Boolean);
  const renders = [];
  for (const requestPath of ['/', ...pageIds.map((id) => `/?page_id=${id}`)]) {
    const page = await sandboxHttp(task, requestPath);
    renders.push({ path: requestPath, status: page.status, timedOut: !!page.timedOut, critical: isCriticalPage(page.body), ms: page.ms });
  }
  const broken = renders.filter((r) => r.status !== 200 || r.critical || r.timedOut);
  check(
    'Every page renders (HTTP 200)',
    broken.length === 0,
    broken.length
      ? broken.map((r) => `${r.path}: ${r.timedOut ? 'timed out' : `HTTP ${r.status}`}${r.critical ? ' (PHP error)' : ''}`).join('; ')
      : `${renders.length} pages checked.`,
  );

  const newDebug = (await readSandboxFile(task, '/tmp/wp-debug.log')).slice(debugOffset);
  const fatals = newDebug.split('\n').filter((line) => /PHP (Fatal|Parse) error|Maximum execution time/i.test(line));
  check('No PHP fatal errors', fatals.length === 0, fatals.length ? fatals.slice(-2).join(' | ').slice(0, 400) : 'No fatal errors in the PHP log.');
  if (fatals.some((line) => /Maximum execution time/i.test(line))) {
    check('Within the time limit', false, `Stopped by the ${task.profile?.max_execution_time || 20}s per-request limit copied from production.`);
  }

  const outbound = parseObserverLog((await readSandboxFile(task, '/tmp/pb-observer.log')).slice(observerOffset)).filter(
    (entry) => entry.type === 'http' && !isCoreHost(hostname(entry.url)),
  );
  const blocked = outbound.filter((entry) => !isApprovedHost(hostname(entry.url)));
  check(
    'No unapproved outbound connections',
    blocked.length === 0,
    blocked.length
      ? `${blocked.length} attempts to ${[...new Set(blocked.map((entry) => hostname(entry.url)))].join(', ')}; all stopped by the sandbox network (${blocked[0].error || 'no response'}).`
      : 'The sandbox observer saw no outbound connections.',
  );
  if (outbound.some((entry) => task.redactionMarker && String(entry.url).includes(task.redactionMarker))) {
    check('No secrets sent out', false, 'A redacted secret value appeared in an outbound request.');
  }

  const adminsAfter = await administratorLogins(task);
  check(
    'Administrator accounts unchanged',
    adminsAfter === task.adminsBefore,
    adminsAfter === task.adminsBefore ? 'Same administrators as before the task.' : `Before: ${task.adminsBefore || '-'}; after: ${adminsAfter || '-'}.`,
  );

  if (await wasOomKilled(task)) check('Within the memory limit', false, `The container exceeded its ${cfg.limits.memory} RAM limit.`);

  return { pass: checks.every((c) => c.ok), checks, pages: renders, outbound };
}
