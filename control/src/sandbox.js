// Sandbox lifecycle: clone live -> sanitize -> create isolated container -> exec -> destroy.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg, pluginDir } from './config.js';
import { docker, run, httpGet, hostOf, sleep } from './proc.js';

const WWW = 82; // www-data uid/gid in the alpine WordPress image

export const sandboxName = (task) => `pb-sbx-${task.id}`;
export const previewHome = (task) => `${cfg.previewPublicUrl}/preview/${task.id}`;

async function chownR(p, uid, gid) {
  await fs.chown(p, uid, gid);
  const st = await fs.stat(p);
  if (st.isDirectory()) {
    for (const e of await fs.readdir(p)) await chownR(path.join(p, e), uid, gid);
  }
}

// Redact anything that looks like a credential in the cloned DB. Runs in the control plane,
// BEFORE the copy reaches the sandbox.
async function sanitizeDb(dbPath, marker) {
  const q = async (sql) => {
    const r = await run('sqlite3', ['-batch', '-noheader', dbPath, sql]);
    if (r.code !== 0) throw new Error(`sqlite: ${r.stderr}`);
    return r.stdout.trim();
  };
  const secretWhere = [
    "option_name LIKE '%password%'",
    "option_name LIKE '%passwd%'",
    "option_name LIKE '%secret%'",
    "option_name LIKE '%server_key%'",
    "option_name LIKE '%api_key%'",
    "option_name LIKE '%apikey%'",
    "option_name LIKE '%token%'",
  ].join(' OR ');

  const users = Number(await q('SELECT COUNT(*) FROM wp_users;'));
  const sessions = Number(await q("SELECT COUNT(*) FROM wp_usermeta WHERE meta_key = 'session_tokens';"));
  const secretNames = (await q(`SELECT option_name FROM wp_options WHERE ${secretWhere};`)).split('\n').filter(Boolean);

  await q(
    [
      "UPDATE wp_users SET user_pass = '!' || lower(hex(randomblob(16))), user_activation_key = '';",
      "DELETE FROM wp_usermeta WHERE meta_key = 'session_tokens';",
      `UPDATE wp_options SET option_value = '${marker}' WHERE ${secretWhere};`,
      "DELETE FROM wp_options WHERE option_name LIKE '\\_transient\\_%' ESCAPE '\\' OR option_name LIKE '\\_site\\_transient\\_%' ESCAPE '\\';",
    ].join(' '),
  );
  return { users, sessions, secretNames };
}

export async function cloneLive(task, log) {
  const work = path.join(cfg.workDir, task.id);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });

  const src = `${cfg.liveContainer}:${cfg.wpRoot}/wp-content`;
  let r = await docker(['cp', `${src}/database/.ht.sqlite`, path.join(work, 'db.sqlite')]);
  if (r.code !== 0) throw new Error(`Gagal menyalin database live: ${r.stderr}`);
  r = await docker(['cp', `${src}/plugins/${cfg.pluginSlug}`, path.join(work, 'plugin')]);
  if (r.code !== 0) throw new Error(`Gagal menyalin plugin kustom: ${r.stderr}`);
  log('clone', 'Salinan situs live dibuat: database + plugin kustom. wp-config.php, backup, dan log live tidak ikut.');

  task.redactionMarker = `PB-REDACTED-${crypto.randomBytes(4).toString('hex')}`;
  const rep = await sanitizeDb(path.join(work, 'db.sqlite'), task.redactionMarker);
  log(
    'sanitize',
    `Sanitasi sebelum masuk sandbox: ${rep.users} password user diacak, ${rep.sessions} sesi login dihapus, ` +
      `${rep.secretNames.length} pengaturan rahasia disamarkan (${rep.secretNames.join(', ') || '-'}).`,
  );

  await chownR(work, WWW, WWW);
  task.workDir = work;
  return work;
}

export async function createSandbox(task, log) {
  const name = sandboxName(task);
  const home = previewHome(task);
  const L = cfg.limits;
  const args = [
    'create',
    '--name', name,
    '--label', 'pressbox=sandbox',
    '--label', `pressbox.task=${task.id}`,
    '--network', cfg.sandboxNetwork,
    '--memory', L.memory,
    '--memory-swap', L.memory,
    '--cpus', String(L.cpus),
    '--pids-limit', String(L.pids),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', `${WWW}:${WWW}`,
    '-e', 'PB_ROLE=sandbox',
    '-e', `PB_HOME=${home}`,
    cfg.sandboxImage,
  ];
  let r = await docker(args);
  if (r.code !== 0) throw new Error(`Gagal membuat sandbox: ${r.stderr}`);
  task.sandbox = { name, home, createdAt: Date.now(), alive: true };

  const dst = `${name}:${cfg.wpRoot}/wp-content`;
  r = await docker(['cp', '-a', path.join(task.workDir, 'db.sqlite'), `${dst}/database/.ht.sqlite`]);
  if (r.code !== 0) throw new Error(`Gagal memasukkan database ke sandbox: ${r.stderr}`);
  r = await docker(['cp', '-a', path.join(task.workDir, 'plugin'), `${dst}/plugins/${cfg.pluginSlug}`]);
  if (r.code !== 0) throw new Error(`Gagal memasukkan plugin ke sandbox: ${r.stderr}`);

  r = await docker(['start', name]);
  if (r.code !== 0) throw new Error(`Gagal menyalakan sandbox: ${r.stderr}`);

  log(
    'create',
    `Sandbox ${name} dibuat: jaringan "${cfg.sandboxNetwork}" (internal, tanpa internet), RAM ${L.memory}, CPU ${L.cpus}, ` +
      `maks ${L.pids} proses, semua capability Linux dicabut, user non-root (www-data), tanpa API key. ` +
      `Batas per request PHP 20 detik.`,
  );

  // Wait until WordPress answers.
  for (let i = 0; i < 30; i++) {
    const res = await sandboxHttp(task, '/');
    if (res.status > 0) return;
    await sleep(500);
  }
  throw new Error('Sandbox tidak merespons setelah 15 detik.');
}

export function sandboxExec(task, argv, { input, timeoutSec = cfg.limits.cmdTimeoutSec, workdir = cfg.wpRoot } = {}) {
  const args = ['exec', '-i', '-w', workdir, sandboxName(task), 'timeout', '-s', 'KILL', String(timeoutSec), ...argv];
  return docker(args, { input, timeoutMs: (timeoutSec + 10) * 1000 });
}

export function sandboxHttp(task, p) {
  const rel = p.startsWith('/') ? p : `/${p}`;
  return httpGet({
    host: sandboxName(task),
    port: 8080,
    path: `/preview/${task.id}${rel}`,
    hostHeader: hostOf(cfg.previewPublicUrl),
    timeoutMs: cfg.limits.httpTimeoutMs,
  });
}

export async function readSandboxFile(task, file) {
  const r = await sandboxExec(task, ['cat', file]);
  return r.code === 0 ? r.stdout : '';
}

export async function lintPlugin(task) {
  const r = await sandboxExec(task, ['find', pluginDir(), '-name', '*.php', '-exec', 'php', '-l', '{}', ';']);
  const out = `${r.stdout}\n${r.stderr}`;
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('No syntax errors'));
}

export async function oomKilled(task) {
  const r = await docker(['inspect', '-f', '{{.State.OOMKilled}}', sandboxName(task)]);
  return r.stdout.trim() === 'true';
}

export async function destroySandbox(task, reason, log) {
  if (!task.sandbox || !task.sandbox.alive) return;
  task.sandbox.alive = false;
  clearTimeout(task.ttlTimer);
  const name = sandboxName(task);
  await docker(['rm', '-f', name]);
  const check = await docker(['ps', '-a', '-q', '--filter', `name=^${name}$`]);
  const gone = check.stdout.trim() === '';
  const lived = Math.round((Date.now() - task.sandbox.createdAt) / 1000);
  log('destroy', `Sandbox ${name} dihancurkan (${reason}) setelah ${lived} detik. ${gone ? 'Terverifikasi: container sudah tidak ada.' : 'PERINGATAN: container masih terdeteksi.'}`);
  if (task.workDir) await fs.rm(task.workDir, { recursive: true, force: true });
}

// On control-plane start: no sandbox may outlive a restart.
export async function destroyOrphans() {
  const r = await docker(['ps', '-a', '-q', '--filter', 'label=pressbox=sandbox']);
  const ids = r.stdout.split('\n').filter(Boolean);
  if (ids.length) await docker(['rm', '-f', ...ids]);
  return ids.length;
}
