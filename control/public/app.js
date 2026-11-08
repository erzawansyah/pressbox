// PressBox chat UI. Plain browser JavaScript, no build step.
const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const SESSION_KEY = 'pressbox-session';
const FINAL_STATUSES = ['review', 'applied', 'apply_failed', 'blocked', 'discarded', 'error'];
const STATUS_LABELS = {
  queued: ['Queued', 'run'],
  cloning: ['Copying production', 'run'],
  sandbox: ['Starting sandbox', 'run'],
  agent: ['Agent working', 'run'],
  gate: ['Running the gate', 'run'],
  review: ['Passed, waiting for you', 'ok'],
  applying: ['Applying to production', 'run'],
  applied: ['Live on production', 'ok'],
  apply_failed: ['Apply failed, production restored', 'bad'],
  blocked: ['Blocked', 'bad'],
  discarded: ['Discarded', ''],
  error: ['Error', 'bad'],
};
const LOG_KINDS = { clone: 'copy', sanitize: 'redact', create: 'sandbox', destroy: 'destroy', live: 'production', backup: 'backup', apply: 'apply', rollback: 'rollback', limit: 'limit' };

let appState = null;
let current = null; // the task card on screen: { id, card, steps, previewBase, previewPath, lastSeq }

function readSession() {
  try {
    return sessionStorage.getItem(SESSION_KEY) || '';
  } catch {
    return ''; // storage blocked (private mode); the visitor unlocks again each load
  }
}
function storeSession(token) {
  try {
    sessionStorage.setItem(SESSION_KEY, token);
  } catch {
    // storage blocked; the token still works for this page view
  }
}
const apiHeaders = () => ({ 'Content-Type': 'application/json', 'X-PressBox-Session': readSession() });

// Tabs
document.querySelectorAll('.tab').forEach((button) =>
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${button.dataset.tab}`));
  }),
);
const showTab = (name) => document.querySelector(`.tab[data-tab="${name}"]`).click();

async function loadState() {
  appState = await (await fetch('/api/state', { headers: apiHeaders() })).json();
  renderModel();
  renderAccess();
  renderProfile(appState.profile);
  const limits = appState.limits;
  $('#limits-text').textContent = `RAM ${limits.memory}, ${limits.cpus} CPU, max ${limits.pids} processes, PHP limits copied from production, max ${limits.agentMaxSteps} agent steps.`;
  $('#live-url').textContent = appState.livePublicUrl;
  if (!$('#live-frame').src) $('#live-frame').src = `${appState.livePublicUrl}/`;
  setBusy(appState.busy);
}

function renderModel() {
  const pill = $('#llm-pill');
  if (appState.mode === 'scripted') {
    $('#scripted-banner').hidden = false;
    pill.textContent = 'Scripted mode (no LLM)';
    pill.className = 'pill warn';
    return;
  }
  pill.textContent = `${appState.provider} · ${appState.model || 'model not set'}`;
  pill.className = `pill ${appState.usesVultr ? 'vultr' : 'warn'}`;
}

function renderAccess() {
  const { access } = appState;
  const unlocked = !access.required || access.session.kind !== 'none';
  $('#access').hidden = unlocked;
  $('#key-form').hidden = !access.ownKeyAllowed;
  $('#composer').hidden = !unlocked;
  $('#chips').hidden = !unlocked;
  const quota = $('#quota');
  if (!access.required) quota.textContent = '';
  else if (access.session.kind === 'judge') quota.textContent = `Judge access · ${access.session.remaining} agent runs left in the shared quota`;
  else if (access.session.kind === 'own-key') quota.textContent = 'Using your own Vultr key for this session';
  else quota.textContent = '';
}

function renderProfile(profile) {
  const box = $('#profile');
  if (!profile) {
    box.innerHTML = '<div class="wide">The server profile is not available.</div>';
    return;
  }
  box.innerHTML = `
    <div><b>PHP</b>${escapeHtml(profile.php_version)}</div>
    <div><b>Memory / request</b>${escapeHtml(profile.php_memory_limit)}</div>
    <div><b>Time / request</b>${escapeHtml(profile.max_execution_time)}s</div>
    <div><b>WordPress</b>${escapeHtml(profile.wp_version)}</div>
    <div><b>Database</b>${escapeHtml(profile.database)}</div>
    <div><b>Theme</b>${escapeHtml(profile.theme.name)}${profile.theme.block_theme ? ' (block)' : ''}</div>
    <div class="wide"><b>Extensions available</b>${escapeHtml(profile.extensions.join(', '))}</div>
    <div class="wide"><b>Not available (the gate rejects code that needs these)</b>${escapeHtml(profile.missing_extensions.join(', ') || 'none')}</div>
    <div class="wide"><b>Source</b>PressBox MU-plugin on production (<code>wp pressbox profile</code>). Sandboxes copy these PHP limits.</div>`;
}

function setBusy(busy) {
  $('#send').disabled = busy;
  $('#input').disabled = busy;
}

async function unlock(body) {
  $('#access-error').textContent = '';
  const res = await fetch('/api/session', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
  const reply = await res.json();
  if (!res.ok) {
    $('#access-error').textContent = reply.error || 'Could not unlock.';
    return;
  }
  storeSession(reply.token);
  await loadState();
}
$('#code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlock({ code: $('#code-input').value });
});
$('#key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlock({ apiKey: $('#key-input').value });
});

// Composer
$('#chips').addEventListener('click', (e) => {
  if (!e.target.dataset.msg) return;
  $('#input').value = e.target.dataset.msg;
  $('#input').focus();
});
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('#input').value.trim();
  if (!message) return;
  setBusy(true);
  const res = await fetch('/api/tasks', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ message }) });
  const reply = await res.json();
  if (!res.ok) {
    alert(reply.error || 'Could not send the request.');
    setBusy(false);
    await loadState();
    return;
  }
  $('#input').value = '';
  startTask(reply.id, message);
  loadState();
});

function startTask(id, message) {
  $('.hello')?.remove();
  $('#thread').insertAdjacentHTML('beforeend', `<div class="msg-user">${escapeHtml(message)}</div>`);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head"><span class="card-title">PressBox</span><span class="status run">Starting</span></div>
    <ul class="steps"></ul>
    <div class="slot-summary"></div>
    <div class="slot-verdict"></div>`;
  $('#thread').appendChild(card);
  current = { id, card, steps: new Map(), previewPath: '/', lastSeq: -1 };
  $('#clog').innerHTML = '';
  document.querySelectorAll('.rule').forEach((rule) => rule.classList.remove('on'));
  $('#changes').innerHTML = '<div class="empty">The agent is working…</div>';
  $('#changes-count').textContent = '';
  resetPreview();
  current.events = new EventSource(`/api/tasks/${id}/events?session=${encodeURIComponent(readSession())}`);
  current.events.onmessage = (msg) => handleEvent(JSON.parse(msg.data));
}

// Agent-chosen paths are appended to trusted origins; only a single-slash relative path is kept.
const siteRelativePath = (path) => (/^\/(?![/\\])/.test(String(path)) ? String(path) : '/');

function addStep(html, className = '') {
  const item = document.createElement('li');
  item.className = `step ${className}`;
  item.innerHTML = html;
  $('.steps', current.card).appendChild(item);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  return item;
}

function setStatus(status) {
  const [text, tone] = STATUS_LABELS[status] || [status, ''];
  const badge = $('.status', current.card);
  badge.textContent = text;
  badge.className = `status ${tone}`;
  if (status !== 'agent') clearThinking();
  if (FINAL_STATUSES.includes(status)) {
    current.events?.close();
    setBusy(false);
  }
}

function clearThinking() {
  current.thinking?.remove();
  current.thinking = null;
}

// Replaces the Apply/Discard buttons and their "not changed yet" note with the outcome.
function settleDecision(html) {
  const verdictBox = $('.verdict', current.card);
  if (!verdictBox) return;
  verdictBox.querySelector('.actions')?.remove();
  verdictBox.querySelector('.note')?.remove();
  verdictBox.insertAdjacentHTML('beforeend', html);
}

function handleEvent(event) {
  current.lastSeq = event.seq;
  switch (event.type) {
    case 'status':
      setStatus(event.status);
      break;
    case 'profile':
      renderProfile(event.profile);
      break;
    case 'thinking':
      current.thinking?.remove();
      current.thinking = addStep('<span class="ic"><span class="spin"></span></span><span class="lbl">Agent thinking…</span>', 'sys');
      break;
    case 'agent_text':
      current.thinking?.remove();
      addStep(`<span class="ic">💬</span><span class="lbl">${escapeHtml(event.text)}</span>`, 'think');
      break;
    case 'tool_start': {
      current.thinking?.remove();
      const item = addStep(`<span class="ic"><span class="spin"></span></span><span><div class="lbl">${escapeHtml(event.label)}</div><div class="res"></div></span>`);
      current.steps.set(event.id, item);
      if (event.name === 'check_site' && event.input?.path) current.previewPath = siteRelativePath(event.input.path);
      break;
    }
    case 'tool_end':
      finishStep(event);
      break;
    case 'containment':
      addContainmentEntry(event);
      if (['create', 'destroy', 'sanitize'].includes(event.kind)) {
        const label = { create: 'Sandbox created', destroy: 'Sandbox destroyed', sanitize: 'Secrets redacted' }[event.kind];
        addStep(`<span class="ic">${event.kind === 'destroy' ? '🗑' : '▣'}</span><span class="lbl">${label}</span>`, 'sys');
      }
      break;
    case 'preview':
      current.previewBase = event.url.replace(/\/$/, '');
      break;
    case 'changeset':
      renderChanges(event.changeset);
      break;
    case 'summary':
      $('.slot-summary', current.card).innerHTML = `<div class="summary">${escapeHtml(event.text)}</div>`;
      break;
    case 'verdict':
      renderVerdict(event.verdict);
      break;
    case 'applied':
      renderApplied(event.result);
      break;
    case 'error':
      current.thinking?.remove();
      $('.slot-verdict', current.card).insertAdjacentHTML('beforeend', `<div class="error-box">${escapeHtml(event.message)}</div>`);
      break;
  }
}

function finishStep(event) {
  const item = current.steps.get(event.id);
  if (!item) return;
  $('.ic', item).textContent = event.ok ? '✓' : '✕';
  $('.res', item).textContent = event.label;
  const check = event.detail;
  const failed = !event.ok || (check && (check.critical_error_page || check.timed_out || check.php_lint_errors?.length || check.outbound_connection_attempts?.length));
  if (failed) item.classList.add('err');
  if (check?.new_php_log) {
    $('.res', item).insertAdjacentHTML('afterend', `<details class="res"><summary>PHP log</summary><pre class="cmds">${escapeHtml(check.new_php_log)}</pre></details>`);
  }
  if (event.name === 'check_site') refreshPreview();
}

function resetPreview() {
  $('#preview-frame').src = 'about:blank';
  $('#preview-url').textContent = 'Starting sandbox…';
  $('#preview-empty').hidden = false;
}
function refreshPreview() {
  if (!current.previewBase) return;
  const url = current.previewBase + current.previewPath;
  $('#preview-url').textContent = url;
  $('#preview-frame').src = url;
  $('#preview-empty').hidden = true;
}
function showSandboxGone() {
  $('#preview-frame').src = 'about:blank';
  $('#preview-url').textContent = 'Sandbox destroyed';
  $('#preview-empty').hidden = false;
  $('#preview-empty').textContent = 'The sandbox for this task has been destroyed.';
}

function renderVerdict(verdict) {
  const slot = $('.slot-verdict', current.card);
  const checks = verdict.checks
    .map((c) => `<li><span>${c.ok ? '✓' : '✕'}</span><span>${escapeHtml(c.name)} <span class="d">· ${escapeHtml(c.detail)}</span></span></li>`)
    .join('');
  slot.innerHTML = `
    <div class="verdict ${verdict.pass ? 'pass' : 'fail'}">
      <h4>${verdict.pass ? 'PASSED the gate' : 'BLOCKED by the gate'}</h4>
      <ul class="checks">${checks}</ul>
      ${
        verdict.pass
          ? `<div class="actions"><button class="pb-button primary" data-act="apply">Apply to production</button><button class="pb-button" data-act="discard">Discard</button></div>
             <div class="note">Check the Sandbox preview and Changes tabs first. Production has not changed yet.</div>`
          : '<div class="note">This change cannot be applied. The sandbox has been destroyed; production was not touched.</div>'
      }
    </div>`;
  if (verdict.pass) {
    showTab('preview');
    refreshPreview();
    slot.querySelector('[data-act="apply"]').onclick = (e) => decide('apply', e.target);
    slot.querySelector('[data-act="discard"]').onclick = (e) => decide('discard', e.target);
  } else {
    showTab('containment');
    showSandboxGone();
  }
}

async function decide(action, button) {
  const id = current.id;
  button.closest('.actions').querySelectorAll('button').forEach((b) => (b.disabled = true));
  button.textContent = action === 'apply' ? 'Applying…' : 'Discarding…';
  const followUp = new EventSource(`/api/tasks/${id}/events?from=${current.lastSeq + 1}&session=${encodeURIComponent(readSession())}`);
  followUp.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    current.lastSeq = event.seq;
    if (event.type === 'containment') addContainmentEntry(event);
    if (event.type === 'status') {
      setStatus(event.status);
      if (['applied', 'apply_failed', 'discarded'].includes(event.status)) followUp.close();
    }
  };
  const res = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST', headers: apiHeaders(), body: '{}' });
  const result = await res.json();
  if (action === 'apply') {
    renderApplied(result);
  } else {
    settleDecision('<div class="note">Discarded. Production is unchanged.</div>');
    showSandboxGone();
  }
}

function renderApplied(result) {
  if (!result || current.appliedShown) return;
  current.appliedShown = true;
  if (result.ok) {
    settleDecision(`<div class="note">✓ Applied to production. Backup: <code>${escapeHtml(result.backup)}</code></div>`);
    $('#live-frame').src = appState.livePublicUrl + current.previewPath;
    showTab('live');
  } else {
    settleDecision(`<div class="error-box">Apply failed: ${escapeHtml(result.error)}. Production was restored from the backup.</div>`);
  }
  showSandboxGone();
}

function addContainmentEntry(event) {
  const item = document.createElement('li');
  item.className = event.kind;
  item.innerHTML = `<span class="t">${clock(event.t)}</span><span class="k">${escapeHtml(LOG_KINDS[event.kind] || event.kind)}</span><span>${escapeHtml(event.text)}</span>`;
  $('#clog').appendChild(item);
  const markRule = (rule) => document.querySelector(`.rule[data-rule="${rule}"]`).classList.add('on');
  if (event.kind === 'create') {
    markRule('isolation');
    markRule('limits');
  }
  if (event.kind === 'sanitize') markRule('secrets');
  if (event.kind === 'destroy') markRule('destroy');
}

// Line diff via longest common subsequence; plugin files are small enough for O(n*m).
const MAX_DIFF_CELLS = 4_000_000;
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_DIFF_CELLS) return b.map((line) => ['+', line]);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push([' ', a[i++]]);
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push(['-', a[i++]]);
    else rows.push(['+', b[j++]]);
  }
  while (i < a.length) rows.push(['-', a[i++]]);
  while (j < b.length) rows.push(['+', b[j++]]);
  return rows;
}

function renderChanges(changeset) {
  const files = Object.entries(changeset.files);
  const total = files.length + changeset.commands.length;
  $('#changes-count').textContent = total || '';
  if (!total) {
    $('#changes').innerHTML = '<div class="empty">The agent made no changes.</div>';
    return;
  }
  const fileBlocks = files.map(([name, file]) => {
    const rows = lineDiff(file.before || '', file.after)
      .map(([mark, line]) => `<div class="${mark === '+' ? 'a' : mark === '-' ? 'd' : ''}">${mark} ${escapeHtml(line)}</div>`)
      .join('');
    const isNew = file.before == null;
    return `<div class="file"><div class="file-head">${escapeHtml(name)} <span class="tag ${isNew ? '' : 'mod'}">${isNew ? 'new file' : 'modified'}</span></div><pre class="diff">${rows}</pre></div>`;
  });
  const commands = changeset.commands.length
    ? `<h3 class="sub">WP-CLI commands replayed on production</h3><div class="cmds">${changeset.commands
        .map((c) => escapeHtml(`wp ${c.args.map((arg) => (arg.length > 140 ? `${arg.slice(0, 137)}…` : arg)).join(' ')}`))
        .join('\n\n')}</div>`
    : '';
  $('#changes').innerHTML = `${fileBlocks.join('')}${commands}<p class="note">On apply, these files are written to the production custom plugin and the WP-CLI commands are replayed. The sandbox database is never copied to production.</p>`;
}

$('#live-reload').addEventListener('click', () => ($('#live-frame').src = $('#live-frame').src));
$('#profile-toggle').addEventListener('click', () => ($('#profile').hidden = !$('#profile').hidden));

loadState();
