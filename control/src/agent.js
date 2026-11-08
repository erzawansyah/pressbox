// Agent loop: brain in the control plane (LLM call), hands in the sandbox (tools).
import { cfg, scriptedMode, pluginDir } from './config.js';
import { chatCompletion } from './llm.js';
import { scriptedCompletion } from './scripted.js';
import { TOOL_DEFS, executeTool, describeCall, describeResult } from './tools.js';
import { sandboxExec } from './sandbox.js';
import { guideIndex, securityBaseline } from './wpguide.js';

async function gatherContext(task) {
  const pages = await sandboxExec(task, ['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--fields=ID,post_title,post_name', '--format=json']);
  const theme = await sandboxExec(task, ['wp', 'theme', 'list', '--status=active', '--field=name']);
  const files = await sandboxExec(task, ['find', pluginDir(), '-type', 'f']);
  let pageList = [];
  try {
    pageList = JSON.parse(pages.stdout);
  } catch {}
  return {
    pages: pageList,
    theme: theme.stdout.trim(),
    files: files.stdout.split('\n').filter(Boolean).map((f) => f.slice(pluginDir().length + 1)),
  };
}

function systemPrompt(ctx, history) {
  const pages = ctx.pages.map((p) => `- ID ${p.ID}: ${p.post_title} (/?page_id=${p.ID})`).join('\n');
  const hist = history.length
    ? `\nEarlier requests in this conversation (already live):\n${history.map((h) => `- "${h.message}" -> ${h.summary}`).join('\n')}\n`
    : '';
  return `You are PressBox, an AI agent that changes a WordPress site for its non-technical owner.
You work on a disposable SANDBOX COPY of the live site. Nothing you do touches the live site; the owner reviews a preview and decides whether to apply it.

Site: "Kedai Kopi Senja", a small coffee shop in Malang, Indonesia. Active block theme: ${ctx.theme}. Plain permalinks (use /?page_id=ID).
Published pages:
${pages}
Custom plugin "${cfg.pluginSlug}" files: ${ctx.files.join(', ')}
${hist}
Rules:
1. All code changes go into the site's single custom plugin "${cfg.pluginSlug}" via write_file (paths relative to the plugin root). The main file is ${cfg.pluginSlug}.php; put new features in includes/*.php and require them from the main file with require_once __DIR__ . '/includes/...'.
2. Never install or depend on third-party plugins. Never edit core or theme files.
3. Content and settings changes go through run_wp (WP-CLI). To place a feature on a page, build a shortcode and add it to the page content with run_wp ["post","update","<ID>","--post_content=<full new content>"] (read the current content first with ["post","get","<ID>","--field=post_content"] and keep it). Wrap shortcodes in <!-- wp:shortcode -->...<!-- /wp:shortcode -->.
4. WordPress coding standards: prefix functions with kss_, escape all output (esc_html, esc_attr, esc_url), sanitize input, verify a nonce on form submissions, no direct SQL. Keep the code small and readable.
5. The sandbox has NO internet access. Features must not depend on external services unless the owner has approved the domain (approved: ${cfg.allowedDomains.join(', ') || 'none'}).
6. After every code or content change, call check_site on the affected page. If there is a PHP error, lint error, critical error page, or timeout, read the error, fix the code, and check again. Do not finish while the site is broken.
   Keep the change minimal: build exactly what the owner asked for, no extra features. Everything you create ships to production, so never create test pages, test harness files, or temporary content. Form submissions are verified by the deterministic gate after you finish, not by you. As soon as check_site is clean for the affected page, call finish.
7. Follow the official WordPress Agent Skills (WordPress/agent-skills). Before writing plugin PHP, read "plugin-development/SKILL.md" with wp_guide; read other guides when the task touches them (block themes, dynamic blocks, WP-CLI safety).
8. Finish by calling finish with a short summary in Bahasa Indonesia for the owner (what changed, which page to look at). Do not claim things you did not verify.

Official WordPress guides available through wp_guide:
${guideIndex().map((g) => `- ${g.id}: ${g.description}`).join('\n')}

Security baseline from the official WordPress plugin-development skill (always apply):
${securityBaseline()}`;
}

export async function runAgent(task, emit, history) {
  const ctx = await gatherContext(task);
  task.context = ctx;
  const messages = [
    { role: 'system', content: systemPrompt(ctx, history) },
    { role: 'user', content: task.message },
  ];
  const complete = scriptedMode() ? (m) => scriptedCompletion(task, m) : (m) => chatCompletion(m, TOOL_DEFS);

  for (let step = 1; step <= cfg.limits.agentMaxSteps; step++) {
    if (task.cancelled) return { finished: false, reason: 'dibatalkan' };
    emit('thinking', { step });
    const { message, usage } = await complete(messages);
    if (usage) task.usage = { prompt: (task.usage?.prompt || 0) + (usage.prompt_tokens || 0), completion: (task.usage?.completion || 0) + (usage.completion_tokens || 0) };

    const calls = message.tool_calls || [];
    messages.push({ role: 'assistant', content: message.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (message.content && message.content.trim()) emit('agent_text', { text: message.content.trim().slice(0, 1500) });

    if (!calls.length) {
      task.summary = (message.content || '').trim();
      return { finished: true, reason: 'tanpa tool call' };
    }

    for (const tc of calls) {
      const name = tc.function?.name;
      let input = {};
      let out;
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch (e) {
        out = { error: `Argumen JSON tidak valid: ${e.message}` };
      }
      const callId = `${step}-${tc.id || name}`;
      emit('tool_start', { id: callId, name, label: describeCall(name, input), input: name === 'write_file' ? { path: input.path } : input });
      if (!out) {
        try {
          out = await executeTool(task, name, input);
        } catch (e) {
          out = { error: e.message };
        }
      }
      emit('tool_end', { id: callId, name, ok: !out.error, label: describeResult(name, out), detail: name === 'check_site' ? out : undefined });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 9000) });
      if (name === 'finish' && !out.error) {
        task.summary = String(input.summary || '').trim();
        return { finished: true, reason: 'finish' };
      }
    }
  }
  return { finished: false, reason: `batas ${cfg.limits.agentMaxSteps} langkah agen tercapai` };
}
