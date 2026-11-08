// The agent's tools. They are its only hands, and every one of them acts inside the
// sandbox: there is deliberately no tool that can reach the production site.
import fs from 'node:fs/promises';
import path from 'node:path';
import { cfg, pluginDir } from './config.js';
import { sandboxExec, sandboxHttp, lintPlugin, readSandboxFile } from './sandbox.js';
import { textExcerpt, isCriticalPage } from './proc.js';
import { guideIndex, readGuide } from './wpguide.js';

const MAX_FILE_BYTES = 120_000;
const MAX_TOOL_OUTPUT_CHARS = 6000;
const WP_CORE_HOST = /^https?:\/\/([^/]+\.)?(wordpress\.org|w\.org)(\/|$)/i;

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
        properties: { path: { type: 'string', description: 'e.g. senja-coffee.php or includes/reservations.php' } },
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
        properties: { path: { type: 'string' }, content: { type: 'string', description: 'Complete file content' } },
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
      parameters: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_site',
      description:
        'Test the sandbox site: PHP lint of the plugin, HTTP status of a page, new PHP errors, outbound connection attempts, and a text excerpt. ' +
        'Always run this after changing code or content.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'e.g. "/" or "/?page_id=7"' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wp_guide',
      description:
        'Read an official WordPress Agent Skills guide (WordPress/agent-skills). Call without "doc" to list guides. ' +
        'Read the relevant guide before writing plugin code, block/theme markup, or WP-CLI changes.',
      parameters: { type: 'object', properties: { doc: { type: 'string', description: 'e.g. "plugin-development/SKILL.md"' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when done. Short summary for a non-technical site owner: what changed and where to see it.',
      parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  },
];

const ALLOWED_EXTENSIONS = new Set(['.php', '.css', '.js', '.json', '.html', '.svg']);

/** Normalises an agent-supplied path and refuses anything outside the custom plugin. */
export function safePluginPath(requested) {
  const raw = String(requested || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!raw || raw.includes('\0')) throw new Error('Empty or invalid path.');
  const relative = path.posix.normalize(raw);
  if (relative === '.' || relative.startsWith('..') || relative.includes('/../') || path.posix.isAbsolute(relative)) {
    throw new Error(`Path outside the custom plugin refused: ${requested}`);
  }
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) throw new Error(`File type not allowed: ${requested}`);
  return relative;
}

const READ_ONLY_GROUPS = new Set(['plugin', 'theme', 'user', 'comment', 'post-type', 'taxonomy', 'role', 'site', 'menu-location']);
const WRITE_GROUPS = new Set(['post', 'option', 'menu', 'term', 'widget', 'sidebar', 'rewrite', 'cache', 'transient', 'post-meta']);
const READ_SUBCOMMANDS = new Set(['list', 'get', 'status', 'exists', 'path', 'search', 'url', 'pluck', 'count']);
const PROTECTED_OPTIONS = /^(siteurl|home|admin_email|new_admin_email|users_can_register|default_role|active_plugins|template|stylesheet|wp_user_roles|.*(password|passwd|secret|token|api_key|apikey|server_key).*)$/i;
const FORBIDDEN_FLAGS = /^--(exec|require|path|url|ssh|http|skip-plugins|skip-themes|context)(=|$)/i;

/**
 * Allow-list for WP-CLI. Returns the cleaned argv and whether it changes state; only
 * state-changing commands are recorded in the changeset and replayed on production.
 */
export function checkWpArgs(args) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('args must be an array, e.g. ["post","list"].');
  const argv = args.map(String);
  if (argv[0] === 'wp') argv.shift();
  for (const arg of argv) if (FORBIDDEN_FLAGS.test(arg)) throw new Error(`Flag not allowed: ${arg}`);

  const [group, subcommand = ''] = argv;
  const isRead = READ_SUBCOMMANDS.has(subcommand) || subcommand.startsWith('is-');
  if (READ_ONLY_GROUPS.has(group)) {
    if (!isRead) throw new Error(`"wp ${group} ${subcommand}" is not allowed (read-only).`);
    return { args: argv, mutating: false };
  }
  if (!WRITE_GROUPS.has(group)) {
    throw new Error(`"wp ${group}" is not allowed. Allowed: ${[...WRITE_GROUPS, ...READ_ONLY_GROUPS].join(', ')}.`);
  }
  if (group === 'option' && !isRead && PROTECTED_OPTIONS.test(argv[2] || '')) throw new Error(`Option "${argv[2]}" is protected.`);
  if (group === 'post' && subcommand === 'meta' && /^(_wp_|session)/.test(argv[4] || '')) throw new Error('Internal post meta is protected.');
  return { args: argv, mutating: !isRead };
}

export function parseObserverLog(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // a line cut off mid-write; the next read picks it up whole
      }
    });
}

// Reads only what was appended since the previous call, so the agent sees new errors only.
async function readNewLines(task, file) {
  const content = await readSandboxFile(task, file);
  task.logOffsets ??= {};
  const from = task.logOffsets[file] || 0;
  task.logOffsets[file] = content.length;
  return content.slice(from);
}

async function originalPluginFile(task, relative) {
  try {
    return await fs.readFile(path.join(task.workDir, 'plugin', relative), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null; // a new file
    throw err;
  }
}

export async function executeTool(task, name, input) {
  const root = pluginDir();
  switch (name) {
    case 'list_files': {
      const res = await sandboxExec(task, ['find', root, '-type', 'f']);
      return { files: res.stdout.split('\n').filter(Boolean).map((f) => f.slice(root.length + 1)).sort() };
    }
    case 'read_file': {
      const relative = safePluginPath(input.path);
      const res = await sandboxExec(task, ['cat', `${root}/${relative}`]);
      return res.code === 0 ? { path: relative, content: res.stdout } : { error: `File not found: ${relative}` };
    }
    case 'write_file': {
      const relative = safePluginPath(input.path);
      const content = String(input.content ?? '');
      if (content.length > MAX_FILE_BYTES) return { error: `File too large (max ${MAX_FILE_BYTES / 1000} KB).` };
      if (!content.trim()) return { error: 'Refusing to write an empty file. Send the complete file content.' };
      const res = await sandboxExec(task, ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', `${root}/${relative}`], { input: content });
      if (res.code !== 0) return { error: res.stderr || 'Write failed.' };
      const entry = task.changeset.files[relative];
      if (entry) entry.after = content;
      else task.changeset.files[relative] = { before: await originalPluginFile(task, relative), after: content };
      return { ok: true, path: relative, bytes: Buffer.byteLength(content) };
    }
    case 'run_wp': {
      const { args, mutating } = checkWpArgs(input.args);
      const res = await sandboxExec(task, ['wp', ...args]);
      const stdout = (res.stdout || '').slice(0, MAX_TOOL_OUTPUT_CHARS);
      if (res.code === 0 && mutating) task.changeset.commands.push({ args, output: stdout.trim().slice(0, 200) });
      return { exit_code: res.code, timed_out: res.timedOut || res.code === 137, stdout, stderr: (res.stderr || '').trim().slice(0, 2000) };
    }
    case 'check_site': {
      const requestPath = input.path || '/';
      const lintErrors = await lintPlugin(task);
      const page = await sandboxHttp(task, requestPath);
      const phpLog = await readNewLines(task, '/tmp/wp-debug.log');
      const outbound = parseObserverLog(await readNewLines(task, '/tmp/pb-observer.log'))
        .filter((entry) => entry.type === 'http' && !WP_CORE_HOST.test(entry.url))
        .map((entry) => ({ url: entry.url, result: entry.error || 'ok' }));
      return {
        path: requestPath,
        http_status: page.status,
        timed_out: !!page.timedOut,
        response_ms: page.ms,
        critical_error_page: isCriticalPage(page.body),
        php_lint_errors: lintErrors,
        new_php_log: phpLog.split('\n').filter((line) => line.trim()).slice(-15).join('\n'),
        outbound_connection_attempts: outbound,
        note: outbound.length ? 'The sandbox has no internet access; every outbound connection fails.' : undefined,
        page_text_excerpt: textExcerpt(page.body, 900),
      };
    }
    case 'wp_guide': {
      if (!input.doc) return { guides: guideIndex() };
      const content = readGuide(input.doc);
      if (!content) return { error: `Guide not found: ${input.doc}`, guides: guideIndex().map((g) => g.id) };
      return { doc: input.doc, source: 'WordPress/agent-skills (official)', content };
    }
    case 'finish':
      return { ok: true };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One-line label for the activity feed when a tool call starts. */
export function describeCall(name, input) {
  switch (name) {
    case 'list_files':
      return 'Listing the custom plugin';
    case 'read_file':
      return `Reading ${input.path}`;
    case 'write_file':
      return `Writing ${input.path}`;
    case 'run_wp':
      return `wp ${(input.args || []).map((arg) => shorten(String(arg), 60)).join(' ')}`;
    case 'check_site':
      return `Testing the sandbox site ${input.path || '/'}`;
    case 'wp_guide':
      return input.doc ? `Reading official WordPress guide: ${input.doc}` : 'Listing official WordPress guides';
    case 'finish':
      return 'Done';
    default:
      return name;
  }
}

/** One-line label for the activity feed when a tool call returns. */
export function describeResult(name, output) {
  if (output?.error) return `Refused or failed: ${output.error}`;
  switch (name) {
    case 'list_files':
      return `${output.files.length} files`;
    case 'read_file':
      return `${output.content.length} characters`;
    case 'write_file':
      return `${output.bytes} bytes written (in the sandbox)`;
    case 'run_wp':
      return output.exit_code === 0
        ? shorten(output.stdout.trim().split('\n')[0] || 'OK', 120)
        : shorten(`Error: ${(output.stderr || '').split('\n')[0]}`, 160);
    case 'check_site': {
      const findings = [];
      if (output.timed_out) findings.push('hit the time limit');
      if (output.critical_error_page) findings.push('PHP error page');
      if (output.php_lint_errors.length) findings.push(`${output.php_lint_errors.length} syntax errors`);
      if (output.new_php_log) findings.push('PHP log entries');
      if (output.outbound_connection_attempts.length) findings.push(`${output.outbound_connection_attempts.length} outbound connection attempts (blocked)`);
      return [`HTTP ${output.http_status || 'no response'}`, ...(findings.length ? findings : ['clean'])].join(', ');
    }
    case 'wp_guide':
      return output.guides ? `${output.guides.length} guides available` : `${output.content.length} characters (WordPress/agent-skills)`;
    default:
      return 'OK';
  }
}
