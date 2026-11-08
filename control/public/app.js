// PressBox chat UI. Plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (t) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let STATE = null;
let current = null; // { id, card, steps, previewPath }

const STATUS_TEXT = {
  queued: ['Antre', 'run'],
  cloning: ['Menyalin situs live', 'run'],
  sandbox: ['Menyiapkan sandbox', 'run'],
  agent: ['Agen bekerja', 'run'],
  gate: ['Menguji di gerbang', 'run'],
  review: ['Lolos, menunggu persetujuanmu', 'ok'],
  applying: ['Menerapkan ke live', 'run'],
  applied: ['Sudah live', 'ok'],
  apply_failed: ['Gagal diterapkan, live dikembalikan', 'bad'],
  blocked: ['Diblokir', 'bad'],
  discarded: ['Dibuang', ''],
  error: ['Error', 'bad'],
};

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${b.dataset.tab}`));
  }),
);
const showTab = (name) => document.querySelector(`.tab[data-tab="${name}"]`).click();

// ---------- init ----------
async function init() {
  STATE = await (await fetch('/api/state')).json();
  const llm = $('#llm-pill');
  if (STATE.mode === 'scripted') {
    $('#scripted-banner').hidden = false;
    llm.textContent = 'Mode skrip (tanpa LLM)';
    llm.classList.add('warn');
  } else {
    llm.textContent = `${STATE.provider} · ${STATE.model || 'model?'}`;
    if (STATE.usesVultr) llm.classList.add('vultr');
    else llm.classList.add('warn');
  }
  $('#limits-text').textContent = `RAM ${STATE.limits.memory}, CPU ${STATE.limits.cpus}, maks ${STATE.limits.pids} proses, 20 detik per request PHP, maks ${STATE.limits.agentMaxSteps} langkah agen.`;
  $('#live-url').textContent = STATE.livePublicUrl;
  $('#live-frame').src = STATE.livePublicUrl + '/';
  setBusy(STATE.busy);
}

function setBusy(b) {
  $('#send').disabled = b;
  $('#input').disabled = b;
}

// ---------- composer ----------
$('#chips').addEventListener('click', (e) => {
  if (e.target.dataset.msg) {
    $('#input').value = e.target.dataset.msg;
    $('#input').focus();
  }
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
  const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  const data = await r.json();
  if (!r.ok) {
    alert(data.error || 'Gagal mengirim');
    setBusy(false);
    return;
  }
  $('#input').value = '';
  startTask(data.id, message);
});

// ---------- task rendering ----------
function startTask(id, message) {
  $('.hello')?.remove();
  const thread = $('#thread');
  thread.insertAdjacentHTML('beforeend', `<div class="msg-user">${esc(message)}</div>`);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-head"><span class="card-title">PressBox</span><span class="status run">Memulai</span></div>
    <ul class="steps"></ul>
    <div class="slot-summary"></div>
    <div class="slot-verdict"></div>`;
  thread.appendChild(card);
  current = { id, card, steps: new Map(), previewPath: '/' };
  $('#clog').innerHTML = '';
  document.querySelectorAll('.rule').forEach((r) => r.classList.remove('on'));
  $('#changes').innerHTML = '<div class="empty">Agen sedang bekerja…</div>';
  $('#changes-count').textContent = '';
  resetPreview();

  const es = new EventSource(`/api/tasks/${id}/events`);
  es.onmessage = (m) => handle(JSON.parse(m.data));
  current.es = es;
}

function addStep(html, cls = '') {
  const li = document.createElement('li');
  li.className = `step ${cls}`;
  li.innerHTML = html;
  $('.steps', current.card).appendChild(li);
  $('#thread').scrollTop = $('#thread').scrollHeight;
  return li;
}

function setStatus(status) {
  const [text, cls] = STATUS_TEXT[status] || [status, ''];
  const el = $('.status', current.card);
  el.textContent = text;
  el.className = `status ${cls}`;
  if (['review', 'applied', 'apply_failed', 'blocked', 'discarded', 'error'].includes(status)) {
    current.es?.close();
    setBusy(false);
    if (status !== 'review') $('#thread').scrollTop = $('#thread').scrollHeight;
  }
}

function handle(ev) {
  current.lastSeq = ev.seq;
  switch (ev.type) {
    case 'status':
      setStatus(ev.status);
      break;
    case 'thinking':
      current.thinking?.remove();
      current.thinking = addStep('<span class="ic"><span class="spin"></span></span><span class="lbl">Agen berpikir…</span>', 'sys');
      break;
    case 'agent_text':
      current.thinking?.remove();
      addStep(`<span class="ic">💬</span><span class="lbl">${esc(ev.text)}</span>`, 'think');
      break;
    case 'tool_start': {
      current.thinking?.remove();
      const li = addStep(`<span class="ic"><span class="spin"></span></span><span><div class="lbl">${esc(ev.label)}</div><div class="res"></div></span>`);
      current.steps.set(ev.id, li);
      if (ev.name === 'check_site' && ev.input?.path) current.previewPath = ev.input.path;
      break;
    }
    case 'tool_end': {
      const li = current.steps.get(ev.id);
      if (!li) break;
      $('.ic', li).textContent = ev.ok ? '✓' : '✕';
      if (!ev.ok) li.classList.add('err');
      $('.res', li).textContent = ev.label;
      if (ev.name === 'check_site' && ev.detail) {
        const d = ev.detail;
        if (d.critical_error_page || d.timed_out || d.php_lint_errors?.length) li.classList.add('err');
        if (d.outbound_connection_attempts?.length) li.classList.add('err');
        if (d.new_php_log) {
          li.querySelector('.res').insertAdjacentHTML('afterend', `<details class="res"><summary>Log PHP</summary><pre class="cmds">${esc(d.new_php_log)}</pre></details>`);
        }
        refreshPreview();
      }
      break;
    }
    case 'containment':
      addContainment(ev);
      if (['create', 'destroy', 'sanitize'].includes(ev.kind)) {
        const label = { create: 'Sandbox dibuat', destroy: 'Sandbox dihancurkan', sanitize: 'Data rahasia disamarkan' }[ev.kind];
        addStep(`<span class="ic">${ev.kind === 'destroy' ? '🗑' : '▣'}</span><span class="lbl">${label}</span>`, 'sys');
      }
      break;
    case 'preview':
      current.previewBase = ev.url.replace(/\/$/, '');
      break;
    case 'changeset':
      renderChanges(ev.changeset);
      break;
    case 'summary':
      $('.slot-summary', current.card).innerHTML = `<div class="summary">${esc(ev.text)}</div>`;
      break;
    case 'verdict':
      renderVerdict(ev.verdict);
      break;
    case 'applied':
      renderApplied(ev.result);
      break;
    case 'error':
      current.thinking?.remove();
      $('.slot-verdict', current.card).insertAdjacentHTML('beforeend', `<div class="error-box">${esc(ev.message)}</div>`);
      break;
  }
}

// ---------- preview ----------
function resetPreview() {
  $('#preview-frame').src = 'about:blank';
  $('#preview-url').textContent = 'Menyiapkan sandbox…';
  $('#preview-empty').hidden = false;
}
function refreshPreview() {
  if (!current.previewBase) return;
  const url = current.previewBase + current.previewPath;
  $('#preview-url').textContent = url;
  $('#preview-frame').src = url;
  $('#preview-empty').hidden = true;
}
function sandboxGone() {
  $('#preview-frame').src = 'about:blank';
  $('#preview-url').textContent = 'Sandbox sudah dihancurkan';
  $('#preview-empty').hidden = false;
  $('#preview-empty').textContent = 'Sandbox untuk tugas ini sudah dihancurkan.';
}

// ---------- verdict ----------
function renderVerdict(v) {
  const slot = $('.slot-verdict', current.card);
  const checks = v.checks.map((c) => `<li><span>${c.ok ? '✓' : '✕'}</span><span>${esc(c.name)} <span class="d">· ${esc(c.detail)}</span></span></li>`).join('');
  slot.innerHTML = `
    <div class="verdict ${v.pass ? 'pass' : 'fail'}">
      <h4>${v.pass ? 'LOLOS gerbang uji' : 'DIBLOKIR gerbang uji'}</h4>
      <ul class="checks">${checks}</ul>
      ${
        v.pass
          ? `<div class="actions"><button class="btn primary" data-act="apply">Terapkan ke live</button><button class="btn" data-act="discard">Buang</button></div>
             <div class="note">Cek dulu tab Preview sandbox dan Perubahan. Situs live belum berubah.</div>`
          : `<div class="note">Perubahan ini tidak bisa diterapkan. Sandbox dihancurkan; situs live tidak tersentuh.</div>`
      }
    </div>`;
  if (v.pass) {
    showTab('preview');
    refreshPreview();
    slot.querySelector('[data-act="apply"]').onclick = (e) => act('apply', e.target);
    slot.querySelector('[data-act="discard"]').onclick = (e) => act('discard', e.target);
  } else {
    document.querySelectorAll('#clog li').length && showTab('containment');
    sandboxGone();
  }
}

async function act(action, btn) {
  const id = current.id;
  btn.closest('.actions').querySelectorAll('button').forEach((b) => (b.disabled = true));
  btn.textContent = action === 'apply' ? 'Menerapkan…' : 'Membuang…';
  const es = new EventSource(`/api/tasks/${id}/events?from=${current.lastSeq + 1 || 0}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'containment') addContainment(ev);
    if (ev.type === 'status') {
      setStatus(ev.status);
      if (['applied', 'apply_failed', 'discarded'].includes(ev.status)) es.close();
    }
  };
  const r = await fetch(`/api/tasks/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await r.json();
  if (action === 'apply') renderApplied(data);
  else {
    btn.closest('.actions').insertAdjacentHTML('afterend', '<div class="note">Perubahan dibuang. Situs live tetap seperti semula.</div>');
    sandboxGone();
  }
}

function renderApplied(res) {
  if (!res || current.appliedShown) return;
  current.appliedShown = true;
  const slot = $('.slot-verdict', current.card);
  if (res.ok) {
    slot.insertAdjacentHTML('beforeend', `<div class="note">✓ Sudah diterapkan ke live. Backup: <code>${esc(res.backup)}</code></div>`);
    $('#live-frame').src = STATE.livePublicUrl + current.previewPath;
    showTab('live');
  } else {
    slot.insertAdjacentHTML('beforeend', `<div class="error-box">Gagal diterapkan: ${esc(res.error)}. Live dikembalikan dari backup.</div>`);
  }
  sandboxGone();
}

// ---------- containment log ----------
const KIND = { clone: 'salin', sanitize: 'sanitasi', create: 'sandbox', destroy: 'hancurkan', live: 'live', backup: 'backup', apply: 'terapkan', rollback: 'rollback', limit: 'batas' };
function addContainment(ev) {
  current.lastSeq = Math.max(current.lastSeq || 0, ev.seq);
  const li = document.createElement('li');
  li.className = ev.kind;
  li.innerHTML = `<span class="t">${fmtTime(ev.t)}</span><span class="k">${esc(KIND[ev.kind] || ev.kind)}</span><span>${esc(ev.text)}</span>`;
  $('#clog').appendChild(li);
  const on = (r) => document.querySelector(`.rule[data-rule="${r}"]`).classList.add('on');
  if (ev.kind === 'create') {
    on('isolation');
    on('limits');
  }
  if (ev.kind === 'sanitize') on('secrets');
  if (ev.kind === 'destroy') on('destroy');
}

// ---------- changes ----------
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return B.map((l) => ['a', l]);
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push([' ', A[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['d', A[i++]]);
    else out.push(['a', B[j++]]);
  }
  while (i < n) out.push(['d', A[i++]]);
  while (j < m) out.push(['a', B[j++]]);
  return out;
}

function renderChanges(cs) {
  const files = Object.entries(cs.files);
  const count = files.length + cs.commands.length;
  $('#changes-count').textContent = count || '';
  if (!count) {
    $('#changes').innerHTML = '<div class="empty">Agen tidak membuat perubahan.</div>';
    return;
  }
  let html = '';
  for (const [name, f] of files) {
    const rows = lineDiff(f.before || '', f.after)
      .map(([k, l]) => `<div class="${k === 'a' ? 'a' : k === 'd' ? 'd' : ''}">${k === 'a' ? '+ ' : k === 'd' ? '- ' : '  '}${esc(l)}</div>`)
      .join('');
    html += `<div class="file"><div class="file-head">${esc(name)} <span class="tag ${f.before == null ? '' : 'mod'}">${f.before == null ? 'file baru' : 'diubah'}</span></div><pre class="diff">${rows}</pre></div>`;
  }
  if (cs.commands.length) {
    html += `<h3 class="sub">Perintah WP-CLI yang akan diputar ulang di live</h3><div class="cmds">${cs.commands
      .map((c) => esc('wp ' + c.args.map((a) => (a.length > 140 ? a.slice(0, 137) + '…' : a)).join(' ')))
      .join('\n\n')}</div>`;
  }
  html += `<p class="note">Saat diterapkan, file di atas ditulis ke plugin kustom situs live dan perintah WP-CLI diputar ulang. Database sandbox tidak pernah disalin ke live.</p>`;
  $('#changes').innerHTML = html;
}

$('#live-reload').addEventListener('click', () => ($('#live-frame').src = $('#live-frame').src));

init();
