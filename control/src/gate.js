// Deterministic gate. The model never decides whether its own work is safe to ship.
import { cfg, pluginDir } from './config.js';
import { sandboxExec, sandboxHttp, lintPlugin, readSandboxFile, oomKilled } from './sandbox.js';
import { parseObserver } from './tools.js';
import { isCriticalPage } from './proc.js';

const DANGEROUS = [
  [/\b(eval|assert)\s*\(/, 'eval/assert'],
  [/\b(exec|shell_exec|system|passthru|proc_open|popen|pcntl_exec)\s*\(/, 'eksekusi perintah sistem'],
  [/`[^`\n]*\$[^`\n]*`/, 'backtick shell'],
  [/\b(fsockopen|pfsockopen|stream_socket_client|curl_exec)\s*\(/, 'koneksi jaringan mentah'],
  [/\b(wp_insert_user|wp_create_user|wp_update_user|add_role|set_role)\s*\(/, 'mengubah akun/role pengguna'],
  [/\b(base64_decode|gzinflate|str_rot13)\s*\(/, 'kode tersamar'],
  [/\$wpdb\s*->\s*query\s*\(/, 'SQL langsung'],
  [/\b(file_put_contents|unlink|rename)\s*\(\s*ABSPATH/, 'menulis/menghapus file inti'],
];

const hostOfUrl = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};
const allowed = (host) => cfg.allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
// WordPress core's own update/pattern checks. Not agent code; reported nowhere as a violation.
export const isCoreHost = (host) => /(^|\.)(wordpress\.org|w\.org)$/i.test(host);

async function adminLogins(task) {
  const r = await sandboxExec(task, ['wp', 'user', 'list', '--role=administrator', '--field=user_login']);
  return r.stdout.split('\n').filter(Boolean).sort().join(',');
}

export async function snapshotBefore(task) {
  task.adminsBefore = await adminLogins(task);
}

export async function runGate(task, agentResult) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('Agen menyelesaikan tugas', agentResult.finished, agentResult.finished ? 'Agen memanggil finish.' : `Tidak selesai: ${agentResult.reason}`);

  const files = Object.keys(task.changeset.files);
  const cmds = task.changeset.commands.length;
  add('Ada perubahan untuk ditinjau', files.length + cmds > 0, `${files.length} file plugin, ${cmds} perintah WP-CLI.`);

  const lint = await lintPlugin(task);
  add('Sintaks PHP plugin valid', lint.length === 0, lint.length ? lint.join(' | ').slice(0, 400) : 'php -l bersih untuk semua file.');

  // Static scan of everything the agent wrote.
  const hits = [];
  const outboundInCode = new Set();
  for (const f of files) {
    const code = task.changeset.files[f].after;
    for (const [re, label] of DANGEROUS) if (re.test(code)) hits.push(`${f}: ${label}`);
    for (const m of code.matchAll(/wp_(?:safe_)?remote_(?:get|post|request|head)\s*\(\s*['"]([^'"]+)['"]/g)) outboundInCode.add(hostOfUrl(m[1]));
  }
  add('Tanpa fungsi berbahaya di kode', hits.length === 0, hits.length ? hits.join('; ') : 'Pemindaian pola: bersih.');
  const badHosts = [...outboundInCode].filter((h) => !allowed(h));
  add(
    'Koneksi keluar hanya ke domain yang disetujui',
    badHosts.length === 0,
    badHosts.length ? `Kode memanggil domain yang belum disetujui: ${badHosts.join(', ')}.` : 'Kode tidak memanggil layanan luar.',
  );

  // Judge the FINAL state only: errors/attempts produced while the gate itself re-renders every page.
  // (Errors the agent hit and already fixed during its loop must not count.)
  const debugStart = (await readSandboxFile(task, '/tmp/wp-debug.log')).length;
  const obsStart = (await readSandboxFile(task, '/tmp/pb-observer.log')).length;

  // Render every published page.
  const pages = await sandboxExec(task, ['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--field=ID']);
  const ids = pages.stdout.split('\n').filter(Boolean);
  const pageResults = [];
  for (const p of ['/', ...ids.map((id) => `/?page_id=${id}`)]) {
    const r = await sandboxHttp(task, p);
    pageResults.push({ path: p, status: r.status, timedOut: !!r.timedOut, critical: isCriticalPage(r.body), ms: r.ms });
  }
  const broken = pageResults.filter((r) => r.status !== 200 || r.critical || r.timedOut);
  add(
    'Semua halaman tampil normal (HTTP 200)',
    broken.length === 0,
    broken.length
      ? broken.map((b) => `${b.path}: ${b.timedOut ? 'melewati batas waktu' : `HTTP ${b.status}`}${b.critical ? ' (error PHP)' : ''}`).join('; ')
      : `${pageResults.length} halaman dicek.`,
  );

  const debug = (await readSandboxFile(task, '/tmp/wp-debug.log')).slice(debugStart);
  const fatals = debug.split('\n').filter((l) => /PHP (Fatal|Parse) error|Maximum execution time/i.test(l));
  const timeLimit = fatals.some((l) => /Maximum execution time/i.test(l));
  add('Tanpa fatal error PHP', fatals.length === 0, fatals.length ? fatals.slice(-2).join(' | ').slice(0, 400) : 'Log PHP bersih dari fatal error.');
  if (timeLimit) add('Dalam batas waktu eksekusi', false, 'Kode dihentikan oleh batas waktu 20 detik per request di sandbox.');

  const obs = parseObserver((await readSandboxFile(task, '/tmp/pb-observer.log')).slice(obsStart));
  const attempts = obs.filter((o) => o.type === 'http' && !isCoreHost(hostOfUrl(o.url)));
  const blockedAttempts = attempts.filter((o) => !allowed(hostOfUrl(o.url)));
  add(
    'Tidak ada percobaan koneksi keluar yang tidak disetujui',
    blockedAttempts.length === 0,
    blockedAttempts.length
      ? `${blockedAttempts.length} percobaan ke ${[...new Set(blockedAttempts.map((o) => hostOfUrl(o.url)))].join(', ')}; semuanya tertahan jaringan sandbox (${blockedAttempts[0].error || 'tanpa respons'}).`
      : 'Pengamat sandbox tidak mencatat koneksi keluar.',
  );
  const leaked = attempts.some((o) => task.redactionMarker && String(o.url).includes(task.redactionMarker));
  if (leaked) add('Data rahasia tidak dikirim keluar', false, 'Nilai rahasia yang disamarkan muncul di permintaan keluar.');

  const adminsAfter = await adminLogins(task);
  add('Akun admin tidak berubah', adminsAfter === task.adminsBefore, adminsAfter === task.adminsBefore ? 'Daftar admin sama seperti sebelum tugas.' : `Sebelum: ${task.adminsBefore || '-'}; sesudah: ${adminsAfter || '-'}.`);

  if (await oomKilled(task)) add('Dalam batas memori', false, `Container dihentikan karena melewati batas RAM ${cfg.limits.memory}.`);

  const pass = checks.every((c) => c.ok);
  return { pass, checks, pages: pageResults, outbound: attempts };
}

export { pluginDir };
