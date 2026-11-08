// Agent tools. The agent's "hands" are inside the sandbox only; no tool can reach the live site.
import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg, pluginDir } from './config.js';
import { sandboxExec, sandboxHttp, lintPlugin, readSandboxFile } from './sandbox.js';
import { textExcerpt, isCriticalPage } from './proc.js';
import { guideIndex, readGuide } from './wpguide.js';

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: "List files in the site's custom plugin (the only code you may change).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the custom plugin. Path is relative to the plugin root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'e.g. kedai-senja-custom.php or includes/foo.php' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file inside the custom plugin (full content). Path relative to plugin root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Complete file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_wp',
      description:
        'Run a WP-CLI command in the sandbox for content and settings (posts/pages, options, menus, terms). ' +
        'Pass arguments as an array without the leading "wp", e.g. ["post","update","7","--post_content=..."]. ' +
        'Reading users/plugins/themes is allowed; installing plugins, eval, db, config and user changes are not.',
      parameters: {
        type: 'object',
        properties: { args: { type: 'array', items: { type: 'string' } } },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_site',
      description:
        'Test the sandbox site: PHP lint of the plugin, HTTP status of a page, new PHP errors, outbound connection attempts, and a text excerpt. ' +
        'Always run this after changing code or content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to request, e.g. "/" or "/?page_id=7"' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wp_guide',
      description:
        'Read an official WordPress Agent Skills guide (from WordPress/agent-skills). Call without "doc" to list guides. ' +
        'Read the relevant guide before writing plugin code, block/theme markup, or WP-CLI changes.',
      parameters: {
        type: 'object',
        properties: { doc: { type: 'string', description: 'Guide id, e.g. "plugin-development/SKILL.md"' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when done. Summary in Bahasa Indonesia for a non-technical site owner: what changed and where to see it.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
];

// ---------- path policy ----------
const ALLOWED_EXT = new Set(['.php', '.css', '.js', '.json', '.txt', '.html', '.svg', '.md']);

export function safeRel(p) {
  const raw = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!raw || raw.includes('\0')) throw new Error('Path kosong atau tidak valid.');
  const rel = path.posix.normalize(raw);
  if (rel === '.' || rel.startsWith('..') || rel.includes('/../') || path.posix.isAbsolute(rel)) {
    throw new Error(`Path di luar plugin kustom ditolak: ${p}`);
  }
  if (!ALLOWED_EXT.has(path.posix.extname(rel).toLowerCase())) {
    throw new Error(`Ekstensi file tidak diizinkan: ${p}`);
  }
  return rel;
}

// ---------- WP-CLI policy ----------
const READ_ONLY_GROUPS = new Set(['plugin', 'theme', 'user', 'comment', 'post-type', 'taxonomy', 'role', 'site', 'menu-location']);
const WRITE_GROUPS = new Set(['post', 'option', 'menu', 'term', 'widget', 'sidebar', 'rewrite', 'cache', 'transient', 'post-meta']);
const READ_SUBS = new Set(['list', 'get', 'status', 'exists', 'is-active', 'is-installed', 'path', 'search', 'url', 'pluck', 'count']);
const PROTECTED_OPTIONS = /^(siteurl|home|admin_email|new_admin_email|users_can_register|default_role|active_plugins|template|stylesheet|wp_user_roles|.*(password|passwd|secret|token|api_key|apikey|server_key).*)$/i;
const FORBIDDEN_ARG = /^--(exec|require|path|url|ssh|http|skip-plugins|skip-themes|context)(=|$)/i;

export function checkWpArgs(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('args harus array, misalnya ["post","list"].');
  const a = args.map(String);
  if (a[0] === 'wp') a.shift();
  for (const x of a) if (FORBIDDEN_ARG.test(x)) throw new Error(`Argumen tidak diizinkan: ${x}`);
  const [group, sub] = a;
  let mutating = false;
  if (READ_ONLY_GROUPS.has(group)) {
    if (!READ_SUBS.has(sub) && !(sub || '').startsWith('is-')) throw new Error(`"wp ${group} ${sub}" tidak diizinkan (hanya baca).`);
  } else if (WRITE_GROUPS.has(group)) {
    mutating = !READ_SUBS.has(sub);
    if (group === 'option' && mutating && PROTECTED_OPTIONS.test(a[2] || '')) {
      throw new Error(`Opsi "${a[2]}" dilindungi dan tidak boleh diubah agen.`);
    }
    if (group === 'post' && sub === 'meta' && /^(_wp_|session)/.test(a[4] || '')) throw new Error('Meta internal tidak boleh diubah.');
  } else {
    throw new Error(`Perintah "wp ${group}" tidak diizinkan. Yang boleh: ${[...WRITE_GROUPS, ...READ_ONLY_GROUPS].join(', ')}.`);
  }
  return { args: a, mutating };
}

// ---------- incremental log reads ----------
async function readNew(task, file, key) {
  const all = await readSandboxFile(task, file);
  task.offsets = task.offsets || {};
  const from = task.offsets[key] || 0;
  task.offsets[key] = all.length;
  return all.slice(from);
}

export function parseObserver(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------- executor ----------
export async function executeTool(task, name, input) {
  const PD = pluginDir();
  switch (name) {
    case 'list_files': {
      const r = await sandboxExec(task, ['find', PD, '-type', 'f']);
      const files = r.stdout.split('\n').filter(Boolean).map((f) => f.slice(PD.length + 1)).sort();
      return { files };
    }
    case 'read_file': {
      const rel = safeRel(input.path);
      const r = await sandboxExec(task, ['cat', `${PD}/${rel}`]);
      if (r.code !== 0) return { error: `File tidak ditemukan: ${rel}` };
      return { path: rel, content: r.stdout };
    }
    case 'write_file': {
      const rel = safeRel(input.path);
      const content = String(input.content ?? '');
      if (content.length > 120_000) return { error: 'File terlalu besar (maks 120 KB).' };
      const full = `${PD}/${rel}`;
      const r = await sandboxExec(task, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', full], { input: content });
      if (r.code !== 0) return { error: r.stderr || 'Gagal menulis file.' };
      if (!(rel in task.changeset.files)) {
        let before = null;
        try {
          before = await fs.readFile(path.join(task.workDir, 'plugin', rel), 'utf8');
        } catch {}
        task.changeset.files[rel] = { before, after: content };
      } else {
        task.changeset.files[rel].after = content;
      }
      return { ok: true, path: rel, bytes: Buffer.byteLength(content) };
    }
    case 'run_wp': {
      const { args, mutating } = checkWpArgs(input.args);
      const r = await sandboxExec(task, ['wp', ...args]);
      const out = (r.stdout || '').slice(0, 6000);
      const err = (r.stderr || '').replace(/^.*Deprecated.*$/gm, '').trim().slice(0, 2000);
      if (r.code === 0 && mutating) task.changeset.commands.push({ args, output: out.trim().slice(0, 200) });
      return { exit_code: r.code, timed_out: r.timedOut || r.code === 137, stdout: out, stderr: err };
    }
    case 'check_site': {
      const p = input.path || '/';
      const lint = await lintPlugin(task);
      const res = await sandboxHttp(task, p);
      const debug = await readNew(task, '/tmp/wp-debug.log', 'debug');
      const obs = parseObserver(await readNew(task, '/tmp/pb-observer.log', 'obs'));
      const outbound = obs
        .filter((o) => o.type === 'http' && !/^https?:\/\/([^/]+\.)?(wordpress\.org|w\.org)(\/|$)/i.test(o.url))
        .map((o) => ({ url: o.url, result: o.error || 'ok' }));
      return {
        path: p,
        http_status: res.status,
        timed_out: !!res.timedOut,
        response_ms: res.ms,
        critical_error_page: isCriticalPage(res.body),
        php_lint_errors: lint,
        new_php_log: debug.split('\n').filter((l) => l.trim()).slice(-15).join('\n'),
        outbound_connection_attempts: outbound,
        note: outbound.length ? 'Sandbox tidak punya akses internet; semua koneksi keluar gagal.' : undefined,
        page_text_excerpt: textExcerpt(res.body, 900),
      };
    }
    case 'wp_guide': {
      if (!input.doc) return { guides: guideIndex() };
      const text = readGuide(input.doc);
      if (!text) return { error: `Panduan tidak ditemukan: ${input.doc}`, guides: guideIndex().map((g) => g.id) };
      return { doc: input.doc, source: 'WordPress/agent-skills (official)', content: text };
    }
    case 'finish':
      return { ok: true };
    default:
      return { error: `Tool tidak dikenal: ${name}` };
  }
}

// Short human label for the activity feed.
export function describeCall(name, input) {
  switch (name) {
    case 'list_files':
      return 'Melihat isi plugin kustom';
    case 'read_file':
      return `Membaca ${input.path}`;
    case 'write_file':
      return `Menulis ${input.path}`;
    case 'run_wp':
      return `wp ${(input.args || []).map((x) => (String(x).length > 60 ? String(x).slice(0, 57) + '...' : x)).join(' ')}`;
    case 'check_site':
      return `Menguji situs sandbox ${input.path || '/'}`;
    case 'wp_guide':
      return input.doc ? `Membaca panduan resmi WordPress: ${input.doc}` : 'Melihat daftar panduan resmi WordPress';
    case 'finish':
      return 'Selesai';
    default:
      return name;
  }
}

export function describeResult(name, out) {
  if (out && out.error) return `Ditolak/gagal: ${out.error}`;
  switch (name) {
    case 'list_files':
      return `${out.files.length} file`;
    case 'read_file':
      return `${out.content.length} karakter`;
    case 'wp_guide':
      return out.guides ? `${out.guides.length} panduan tersedia` : `${out.content.length} karakter (WordPress/agent-skills)`;
    case 'write_file':
      return `${out.bytes} byte ditulis (di sandbox)`;
    case 'run_wp':
      return out.exit_code === 0 ? (out.stdout.trim().split('\n')[0] || 'OK').slice(0, 120) : `Error: ${(out.stderr || '').split('\n')[0]}`.slice(0, 160);
    case 'check_site': {
      const bits = [`HTTP ${out.http_status || 'tidak merespons'}`];
      if (out.timed_out) bits.push('melewati batas waktu');
      if (out.critical_error_page) bits.push('halaman error PHP');
      if (out.php_lint_errors.length) bits.push(`${out.php_lint_errors.length} error sintaks`);
      if (out.new_php_log) bits.push('ada log error PHP');
      if (out.outbound_connection_attempts.length) bits.push(`${out.outbound_connection_attempts.length} percobaan koneksi keluar (diblokir)`);
      if (bits.length === 1) bits.push('bersih');
      return bits.join(', ');
    }
    default:
      return 'OK';
  }
}

export { cfg };
