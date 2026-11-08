// Agent loop. The brain (LLM call) runs in the control plane; the hands (tools) act
// only inside the sandbox.
import { cfg, scriptedMode, pluginDir } from './config.js';
import { chatCompletion } from './llm.js';
import { scriptedCompletion } from './scripted.js';
import { TOOL_DEFS, executeTool, describeCall, describeResult } from './tools.js';
import { sandboxExec } from './sandbox.js';
import { guideIndex, securityBaseline } from './wpguide.js';

const MAX_TOOL_RESULT_CHARS = 9000;
const STEP_BUDGET_WARNING = 4;

async function gatherSiteContext(task) {
  const pages = await sandboxExec(task, ['wp', 'post', 'list', '--post_type=page', '--post_status=publish', '--fields=ID,post_title,post_name', '--format=json']);
  const theme = await sandboxExec(task, ['wp', 'theme', 'list', '--status=active', '--field=name']);
  const files = await sandboxExec(task, ['find', pluginDir(), '-type', 'f']);
  let pageList = [];
  try {
    pageList = JSON.parse(pages.stdout);
  } catch {
    pageList = []; // the agent can still list pages itself with run_wp
  }
  return {
    pages: pageList,
    theme: theme.stdout.trim(),
    files: files.stdout.split('\n').filter(Boolean).map((f) => f.slice(pluginDir().length + 1)),
  };
}

function describeProfile(profile) {
  if (!profile) return 'Production server profile: unavailable; assume PHP 8.2 with common extensions.';
  return [
    `Production server profile (read by the PressBox MU-plugin; treat it as hard limits):`,
    `- PHP ${profile.php_version}, memory_limit ${profile.php_memory_limit}, max_execution_time ${profile.max_execution_time}s`,
    `- PHP extensions available: ${profile.extensions.join(', ')}`,
    `- NOT available (do not use them): ${profile.missing_extensions.join(', ') || 'none'}`,
    `- WordPress ${profile.wp_version}, ${profile.database}, theme ${profile.theme.name}${profile.theme.block_theme ? ' (block theme)' : ''}`,
  ].join('\n');
}

function systemPrompt(ctx, profile, history) {
  const pages = ctx.pages.map((p) => `- ID ${p.ID}: ${p.post_title} (/?page_id=${p.ID})`).join('\n');
  const earlier = history.length
    ? `\nEarlier requests in this conversation (already live):\n${history.map((h) => `- "${h.message}" -> ${h.summary}`).join('\n')}\n`
    : '';
  return `You are PressBox, an AI agent that changes a WordPress site for its non-technical owner.
You work on a disposable SANDBOX COPY of the production site. Nothing you do touches production; the owner reviews a preview and decides whether to apply it.

Site: "Senja Coffee", a small coffee shop in Malang, Indonesia. Active theme: ${ctx.theme}. Plain permalinks (use /?page_id=ID).
Published pages:
${pages}
Custom plugin "${cfg.pluginSlug}" files: ${ctx.files.join(', ')}
${describeProfile(profile)}
${earlier}
Rules:
1. All code changes go into the site's single custom plugin "${cfg.pluginSlug}" via write_file (paths relative to the plugin root). The main file is ${cfg.pluginSlug}.php; put a new feature in ONE file includes/<feature>.php and add one require_once __DIR__ . '/includes/<feature>.php'; line to the main file. Write each file once with complete content; rewrite it only to fix an error check_site reported. No README or documentation files, no refactoring into extra files.
2. Never install or depend on third-party plugins. Never edit core or theme files.
3. Content and settings changes go through run_wp (WP-CLI). To place a feature on a page, build a shortcode and add it to the page content with run_wp ["post","update","<ID>","--post_content=<full new content>"] (read the current content first with ["post","get","<ID>","--field=post_content"] and keep it). Wrap shortcodes in <!-- wp:shortcode -->...<!-- /wp:shortcode -->.
4. WordPress coding standards: prefix functions with senja_, escape all output (esc_html, esc_attr, esc_url), sanitize input, verify a nonce on form submissions, no direct SQL. Keep the code small and readable.
5. The sandbox has NO internet access. If the owner asks for a feature that needs an external service, build it with the WordPress HTTP API (wp_remote_get) and say in your summary which domain it needs; the gate, not you, decides whether that domain is approved (approved now: ${cfg.allowedDomains.join(', ') || 'none'}).
6. Respect the production server profile above: code needing a missing PHP extension, more memory, or more time will be rejected by the gate.
7. After every code or content change, call check_site on the affected page. If there is a PHP error, lint error, critical error page, or timeout, read the error, fix the code, and check again. Do not finish while the site is broken.
   Keep the change minimal: build exactly what the owner asked for, no extra features. Everything you create ships to production, so never create test pages, test harness files, or temporary content. Form submissions are verified by the deterministic gate after you finish, not by you. As soon as check_site is clean for the affected page, call finish.
8. Follow the official WordPress Agent Skills (WordPress/agent-skills). Before writing plugin PHP, read "plugin-development/SKILL.md" with wp_guide; read other guides when the task touches them.
9. Finish by calling finish with a short summary in English for the owner (what changed, which page to look at). Do not claim things you did not verify. Write all site content in English.

Official WordPress guides available through wp_guide:
${guideIndex().map((g) => `- ${g.id}: ${g.description}`).join('\n')}

Security baseline from the official WordPress plugin-development skill (always apply):
${securityBaseline()}`;
}

/**
 * Runs the tool loop until the agent calls finish, stops calling tools, or hits the step
 * limit. Progress is streamed through `emit`.
 */
export async function runAgent(task, emit, history) {
  const ctx = await gatherSiteContext(task);
  task.context = ctx;
  const messages = [
    { role: 'system', content: systemPrompt(ctx, task.profile, history) },
    { role: 'user', content: task.message },
  ];
  const complete = scriptedMode()
    ? (conversation) => scriptedCompletion(task, conversation)
    : (conversation) => chatCompletion(conversation, TOOL_DEFS, task.apiKey);

  for (let step = 1; step <= cfg.limits.agentMaxSteps; step++) {
    if (task.cancelled) return { finished: false, reason: 'cancelled' };
    emit('thinking', { step });
    const { message, usage } = await complete(messages);
    if (usage) {
      task.usage = {
        prompt: (task.usage?.prompt || 0) + (usage.prompt_tokens || 0),
        completion: (task.usage?.completion || 0) + (usage.completion_tokens || 0),
      };
    }

    const calls = message.tool_calls || [];
    messages.push({ role: 'assistant', content: message.content || null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (message.content?.trim()) emit('agent_text', { text: message.content.trim().slice(0, 1500) });

    if (!calls.length) {
      task.summary = (message.content || '').trim();
      return { finished: true, reason: 'no further tool calls' };
    }

    const stepsLeft = cfg.limits.agentMaxSteps - step;
    for (const call of calls) {
      const name = call.function?.name;
      const callId = `${step}-${call.id || name}`;
      let input = {};
      let output;
      try {
        input = JSON.parse(call.function?.arguments || '{}');
      } catch (err) {
        output = { error: `Invalid JSON arguments: ${err.message}` };
      }
      emit('tool_start', { id: callId, name, label: describeCall(name, input), input: name === 'write_file' ? { path: input.path } : input });
      if (!output) {
        try {
          output = await executeTool(task, name, input);
        } catch (err) {
          output = { error: err.message };
        }
      }
      emit('tool_end', { id: callId, name, ok: !output.error, label: describeResult(name, output), detail: name === 'check_site' ? output : undefined });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output).slice(0, MAX_TOOL_RESULT_CHARS) });
      if (name === 'finish' && !output.error) {
        task.summary = String(input.summary || '').trim();
        return { finished: true, reason: 'finish' };
      }
    }
    // Models tend to keep polishing; a visible budget gets them to wrap up while the site is clean.
    if (stepsLeft === STEP_BUDGET_WARNING) {
      messages.push({ role: 'user', content: `PressBox: ${stepsLeft} steps left. If check_site is clean for the affected page, call finish now; otherwise fix only the reported error.` });
    }
  }
  return { finished: false, reason: `reached the ${cfg.limits.agentMaxSteps}-step limit` };
}
