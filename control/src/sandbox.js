// Sandbox lifecycle: clone production, redact secrets, start an isolated container,
// run commands in it, destroy it. Nothing in here ever executes agent-written code in
// the control plane itself; all execution is `docker exec` into the sandbox.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg, pluginDir } from './config.js';
import { docker, run, httpGet, hostOf, sleep } from './proc.js';

const WWW_DATA_UID = 82; // www-data in the alpine WordPress image
const READY_POLL_MS = 500;
const READY_ATTEMPTS = 30;

export const sandboxName = (task) => `pb-sbx-${task.id}`;
export const previewHome = (task) => `${cfg.previewPublicUrl}/preview/${task.id}`;

async function chownRecursive(target, uid, gid) {
  await fs.chown(target, uid, gid);
  if ((await fs.stat(target)).isDirectory()) {
    for (const entry of await fs.readdir(target)) await chownRecursive(path.join(target, entry), uid, gid);
  }
}

// Option names that usually hold credentials. Matching values are replaced before the
// copy reaches the sandbox; network isolation is the second line of defence for misses.
const SECRET_OPTION_SQL = ['%password%', '%passwd%', '%secret%', '%key%', '%token%', '%credential%', '%license%', '%auth%']
  .map((pattern) => `option_name LIKE '${pattern}'`)
  .join(' OR ');

async function redactDatabase(dbPath, marker) {
  const sql = async (statement) => {
    const res = await run('sqlite3', ['-batch', '-noheader', dbPath, statement]);
    if (res.code !== 0) throw new Error(`sqlite: ${res.stderr}`);
    return res.stdout.trim();
  };
  const userCount = Number(await sql('SELECT COUNT(*) FROM wp_users;'));
  const sessionCount = Number(await sql("SELECT COUNT(*) FROM wp_usermeta WHERE meta_key = 'session_tokens';"));
  const secretOptions = (await sql(`SELECT option_name FROM wp_options WHERE ${SECRET_OPTION_SQL};`)).split('\n').filter(Boolean);

  await sql(
    [
      // An invalid hash: nobody can log in to the copy with a production password.
      "UPDATE wp_users SET user_pass = '!' || lower(hex(randomblob(16))), user_activation_key = '';",
      "DELETE FROM wp_usermeta WHERE meta_key = 'session_tokens';",
      `UPDATE wp_options SET option_value = '${marker}' WHERE ${SECRET_OPTION_SQL};`,
      "DELETE FROM wp_options WHERE option_name LIKE '\\_transient\\_%' ESCAPE '\\' OR option_name LIKE '\\_site\\_transient\\_%' ESCAPE '\\';",
    ].join(' '),
  );
  return { userCount, sessionCount, secretOptions };
}

export async function cloneProduction(task, log) {
  const workDir = path.join(cfg.workDir, task.id);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const source = `${cfg.liveContainer}:${cfg.wpRoot}/wp-content`;
  let res = await docker(['cp', `${source}/database/.ht.sqlite`, path.join(workDir, 'db.sqlite')]);
  if (res.code !== 0) throw new Error(`Could not copy the production database: ${res.stderr}`);
  res = await docker(['cp', `${source}/plugins/${cfg.pluginSlug}`, path.join(workDir, 'plugin')]);
  if (res.code !== 0) throw new Error(`Could not copy the custom plugin: ${res.stderr}`);
  log('clone', 'Copied production: database and the custom plugin. wp-config.php, backups and logs stay behind.');

  task.redactionMarker = `PB-REDACTED-${crypto.randomBytes(4).toString('hex')}`;
  const report = await redactDatabase(path.join(workDir, 'db.sqlite'), task.redactionMarker);
  log(
    'sanitize',
    `Redacted before the copy entered the sandbox: ${report.userCount} user passwords scrambled, ` +
      `${report.sessionCount} login sessions removed, ${report.secretOptions.length} secret settings masked ` +
      `(${report.secretOptions.join(', ') || 'none'}).`,
  );

  await chownRecursive(workDir, WWW_DATA_UID, WWW_DATA_UID);
  task.workDir = workDir;
}

export async function createSandbox(task, log) {
  const name = sandboxName(task);
  const home = previewHome(task);
  const limits = cfg.limits;
  // Mirror production's PHP limits so code that would time out or run out of memory there fails here.
  const phpMemory = task.profile?.php_memory_limit || '128M';
  const phpMaxSeconds = task.profile?.max_execution_time || 20;

  let res = await docker([
    'create',
    '--name', name,
    '--label', 'pressbox=sandbox',
    '--label', `pressbox.task=${task.id}`,
    '--network', cfg.sandboxNetwork,
    '--memory', limits.memory,
    '--memory-swap', limits.memory,
    '--cpus', String(limits.cpus),
    '--pids-limit', String(limits.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${WWW_DATA_UID}:${WWW_DATA_UID}`,
    '-e', 'PB_ROLE=sandbox',
    '-e', `PB_HOME=${home}`,
    '-e', `PB_PHP_MEMORY_LIMIT=${phpMemory}`,
    '-e', `PB_PHP_MAX_EXECUTION_TIME=${phpMaxSeconds}`,
    cfg.sandboxImage,
  ]);
  if (res.code !== 0) throw new Error(`Could not create the sandbox: ${res.stderr}`);
  task.sandbox = { name, home, createdAt: Date.now(), alive: true };

  const target = `${name}:${cfg.wpRoot}/wp-content`;
  res = await docker(['cp', '-a', path.join(task.workDir, 'db.sqlite'), `${target}/database/.ht.sqlite`]);
  if (res.code !== 0) throw new Error(`Could not load the database into the sandbox: ${res.stderr}`);
  res = await docker(['cp', '-a', path.join(task.workDir, 'plugin'), `${target}/plugins/${cfg.pluginSlug}`]);
  if (res.code !== 0) throw new Error(`Could not load the plugin into the sandbox: ${res.stderr}`);
  res = await docker(['start', name]);
  if (res.code !== 0) throw new Error(`Could not start the sandbox: ${res.stderr}`);

  log(
    'create',
    `Sandbox ${name} started on network "${cfg.sandboxNetwork}" (internal: no internet, no cloud metadata, no route to production). ` +
      `RAM ${limits.memory}, ${limits.cpus} CPU, max ${limits.pids} processes, all Linux capabilities dropped, non-root user, no API keys. ` +
      `PHP limits copied from production: ${phpMemory} memory, ${phpMaxSeconds}s per request.`,
  );

  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    if ((await sandboxHttp(task, '/')).status > 0) return;
    await sleep(READY_POLL_MS);
  }
  throw new Error('The sandbox did not answer within 15 seconds.');
}

export function sandboxExec(task, argv, { input, timeoutSec = cfg.limits.cmdTimeoutSec, workdir = cfg.wpRoot } = {}) {
  const args = ['exec', '-i', '-w', workdir, sandboxName(task), 'timeout', '-s', 'KILL', String(timeoutSec), ...argv];
  return docker(args, { input, timeoutMs: (timeoutSec + 10) * 1000 });
}

export function sandboxHttp(task, requestPath) {
  const relative = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
  return httpGet({
    host: sandboxName(task),
    port: 8080,
    path: `/preview/${task.id}${relative}`,
    hostHeader: hostOf(cfg.previewPublicUrl),
    timeoutMs: cfg.limits.httpTimeoutMs,
  });
}

// Missing files read as empty: logs only exist once something has been written to them.
export async function readSandboxFile(task, file) {
  const res = await sandboxExec(task, ['cat', file]);
  return res.code === 0 ? res.stdout : '';
}

export async function lintPlugin(task) {
  const res = await sandboxExec(task, ['find', pluginDir(), '-name', '*.php', '-exec', 'php', '-l', '{}', ';']);
  return `${res.stdout}\n${res.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('No syntax errors'));
}

export async function wasOomKilled(task) {
  const res = await docker(['inspect', '-f', '{{.State.OOMKilled}}', sandboxName(task)]);
  return res.stdout.trim() === 'true';
}

export async function destroySandbox(task, reason, log) {
  if (!task.sandbox?.alive) return;
  task.sandbox.alive = false;
  clearTimeout(task.ttlTimer);
  const name = sandboxName(task);
  await docker(['rm', '-f', name]);
  const leftover = await docker(['ps', '-a', '-q', '--filter', `name=^${name}$`]);
  const gone = leftover.stdout.trim() === '';
  const seconds = Math.round((Date.now() - task.sandbox.createdAt) / 1000);
  log('destroy', `Sandbox ${name} destroyed (${reason}) after ${seconds}s. ${gone ? 'Verified: the container no longer exists.' : 'WARNING: the container is still listed.'}`);
  if (task.workDir) await fs.rm(task.workDir, { recursive: true, force: true });
}

// No sandbox may outlive a control-plane restart.
export async function destroyOrphanSandboxes() {
  const res = await docker(['ps', '-a', '-q', '--filter', 'label=pressbox=sandbox']);
  const ids = res.stdout.split('\n').filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
  return ids.length;
}
