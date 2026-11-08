// Apply an approved changeset to the live site by REPLAYING it: write plugin files + rerun WP-CLI.
// The sandbox database is never copied back to live.
import { cfg, pluginDir } from './config.js';
import { docker, httpGet, hostOf, isCriticalPage } from './proc.js';
import { checkWpArgs, safeRel } from './tools.js';

const liveExec = (argv, opts = {}) =>
  docker(['exec', '-i', '-w', cfg.wpRoot, cfg.liveContainer, ...argv], { timeoutMs: 60000, ...opts });

export const liveHttp = (path = '/') =>
  httpGet({ host: cfg.liveContainer, port: 8080, path, hostHeader: hostOf(cfg.livePublicUrl), timeoutMs: 25000 });

async function liveHealth() {
  const pages = await liveExec(['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--field=ID']);
  const paths = ['/', ...pages.stdout.split('\n').filter(Boolean).map((id) => `/?page_id=${id}`)];
  const bad = [];
  for (const p of paths) {
    const r = await liveHttp(p);
    if (r.status !== 200 || isCriticalPage(r.body)) bad.push(`${p}: HTTP ${r.status}${r.timedOut ? ' (timeout)' : ''}`);
  }
  return { ok: bad.length === 0, checked: paths.length, bad };
}

export async function liveSnapshot() {
  const admins = await liveExec(['wp', 'user', 'list', '--role=administrator', '--field=user_login']);
  const files = await liveExec(['find', pluginDir(), '-type', 'f']);
  const home = await liveHttp('/');
  return {
    admins: admins.stdout.split('\n').filter(Boolean).sort().join(','),
    pluginFiles: files.stdout.split('\n').filter(Boolean).length,
    homeStatus: home.status,
  };
}

export async function applyToLive(task, log) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `wp-content/pb-backups/${ts}`;
  const previewHome = task.sandbox.home;

  let r = await liveExec(['sh', '-c', `mkdir -p "$1" && cp wp-content/database/.ht.sqlite "$1/" && cp -r "wp-content/plugins/${cfg.pluginSlug}" "$1/plugin"`, 'sh', backup]);
  if (r.code !== 0) throw new Error(`Backup live gagal, penerapan dibatalkan: ${r.stderr}`);
  log('backup', `Backup live dibuat: ${backup} (database + plugin kustom).`);

  try {
    for (const [rel0, f] of Object.entries(task.changeset.files)) {
      const rel = safeRel(rel0);
      const full = `${pluginDir()}/${rel}`;
      r = await liveExec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', full], { input: f.after });
      if (r.code !== 0) throw new Error(`Gagal menulis ${rel}: ${r.stderr}`);
      log('apply', `File plugin ditulis ke live: ${rel}`);
    }
    for (const c of task.changeset.commands) {
      const { args } = checkWpArgs(c.args.map((a) => a.split(previewHome).join(cfg.livePublicUrl)));
      r = await liveExec(['wp', ...args]);
      if (r.code !== 0) throw new Error(`Perintah gagal di live: wp ${args.slice(0, 3).join(' ')}: ${r.stderr.slice(0, 300)}`);
      log('apply', `Perintah diputar ulang di live: wp ${args.slice(0, 3).join(' ')}`);
    }
    const lint = await liveExec(['find', pluginDir(), '-name', '*.php', '-exec', 'php', '-l', '{}', ';']);
    if (/error/i.test(lint.stdout.replace(/No syntax errors detected/g, ''))) throw new Error(`Lint live gagal: ${lint.stdout.slice(0, 300)}`);
    const health = await liveHealth();
    if (!health.ok) throw new Error(`Cek kesehatan live gagal: ${health.bad.join('; ')}`);
    log('apply', `Cek kesehatan live: ${health.checked} halaman HTTP 200.`);
    return { ok: true, backup };
  } catch (e) {
    log('rollback', `Gagal: ${e.message}. Mengembalikan live dari backup...`);
    await liveExec([
      'sh',
      '-c',
      `cp "$1/.ht.sqlite" wp-content/database/.ht.sqlite && rm -rf "wp-content/plugins/${cfg.pluginSlug}" && cp -r "$1/plugin" "wp-content/plugins/${cfg.pluginSlug}"`,
      'sh',
      backup,
    ]);
    const health = await liveHealth();
    log('rollback', `Rollback selesai. Live ${health.ok ? 'normal kembali' : 'MASIH bermasalah: ' + health.bad.join('; ')}.`);
    return { ok: false, error: e.message, backup };
  }
}
