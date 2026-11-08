// The production site: read its server profile, check its health, and apply an approved
// changeset by replaying it (write plugin files, rerun WP-CLI). The sandbox database is
// never copied back, so production data written meanwhile is never overwritten.
import { cfg, pluginDir } from './config.js';
import { docker, httpGet, hostOf, isCriticalPage } from './proc.js';
import { checkWpArgs, safePluginPath } from './tools.js';

const productionExec = (argv, options = {}) =>
  docker(['exec', '-i', '-w', cfg.wpRoot, cfg.liveContainer, ...argv], { timeoutMs: 60000, ...options });

export const productionHttp = (path = '/') =>
  httpGet({ host: cfg.liveContainer, port: 8080, path, hostHeader: hostOf(cfg.livePublicUrl), timeoutMs: 25000 });

let cachedProfile = null;

/** Server profile reported by the PressBox MU-plugin (`wp pressbox profile`). */
export async function readServerProfile({ refresh = false } = {}) {
  if (cachedProfile && !refresh) return cachedProfile;
  const res = await productionExec(['wp', 'pressbox', 'profile']);
  if (res.code !== 0) return null;
  try {
    cachedProfile = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    return null; // unexpected output; callers treat a missing profile as "assume defaults"
  }
  return cachedProfile;
}

async function healthCheck() {
  const pages = await productionExec(['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--field=ID']);
  const paths = ['/', ...pages.stdout.split('\n').filter(Boolean).map((id) => `/?page_id=${id}`)];
  const failures = [];
  for (const path of paths) {
    const page = await productionHttp(path);
    if (page.status !== 200 || isCriticalPage(page.body)) failures.push(`${path}: HTTP ${page.status}${page.timedOut ? ' (timeout)' : ''}`);
  }
  return { ok: failures.length === 0, checked: paths.length, failures };
}

/** Fingerprint used to show that a blocked or discarded task left production untouched. */
export async function productionSnapshot() {
  const admins = await productionExec(['wp', 'user', 'list', '--role=administrator', '--field=user_login']);
  const files = await productionExec(['find', pluginDir(), '-type', 'f']);
  const home = await productionHttp('/');
  return {
    admins: admins.stdout.split('\n').filter(Boolean).sort().join(','),
    pluginFiles: files.stdout.split('\n').filter(Boolean).length,
    homeStatus: home.status,
  };
}

export async function applyToProduction(task, log) {
  const backup = `wp-content/pb-backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const previewHome = task.sandbox.home;

  let res = await productionExec([
    'sh', '-c', `mkdir -p "$1" && cp wp-content/database/.ht.sqlite "$1/" && cp -r "wp-content/plugins/${cfg.pluginSlug}" "$1/plugin"`, 'sh', backup,
  ]);
  if (res.code !== 0) throw new Error(`Production backup failed, nothing was applied: ${res.stderr}`);
  log('backup', `Production backup created: ${backup} (database and custom plugin).`);

  try {
    for (const [requested, file] of Object.entries(task.changeset.files)) {
      const relative = safePluginPath(requested);
      res = await productionExec(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `${pluginDir()}/${relative}`], { input: file.after });
      if (res.code !== 0) throw new Error(`Could not write ${relative}: ${res.stderr}`);
      log('apply', `Plugin file written to production: ${relative}`);
    }
    for (const command of task.changeset.commands) {
      // URLs the agent wrote while working on the preview must point at production.
      const { args } = checkWpArgs(command.args.map((arg) => arg.split(previewHome).join(cfg.livePublicUrl)));
      res = await productionExec(['wp', ...args]);
      if (res.code !== 0) throw new Error(`Command failed on production: wp ${args.slice(0, 3).join(' ')}: ${res.stderr.slice(0, 300)}`);
      log('apply', `Replayed on production: wp ${args.slice(0, 3).join(' ')}`);
    }
    const lint = await productionExec(['find', pluginDir(), '-name', '*.php', '-exec', 'php', '-l', '{}', ';']);
    if (/error/i.test(lint.stdout.replace(/No syntax errors detected/g, ''))) throw new Error(`PHP lint failed on production: ${lint.stdout.slice(0, 300)}`);
    const health = await healthCheck();
    if (!health.ok) throw new Error(`Production health check failed: ${health.failures.join('; ')}`);
    log('apply', `Production health check: ${health.checked} pages return HTTP 200.`);
    return { ok: true, backup };
  } catch (err) {
    log('rollback', `${err.message}. Restoring production from the backup...`);
    await productionExec([
      'sh', '-c',
      `cp "$1/.ht.sqlite" wp-content/database/.ht.sqlite && rm -rf "wp-content/plugins/${cfg.pluginSlug}" && cp -r "$1/plugin" "wp-content/plugins/${cfg.pluginSlug}"`,
      'sh', backup,
    ]);
    const health = await healthCheck();
    log('rollback', `Rollback finished. Production is ${health.ok ? 'healthy again' : `STILL failing: ${health.failures.join('; ')}`}.`);
    return { ok: false, error: err.message, backup };
  }
}
