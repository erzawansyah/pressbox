// PressBox control plane HTTP servers.
//   :3000  app (chat UI + JSON API + SSE)
//   :3001  preview proxy to sandboxes (separate origin from the app on purpose)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, scriptedMode, usesVultr } from './config.js';
import { hostOf } from './proc.js';
import { destroyOrphans, sandboxName } from './sandbox.js';
import { createTask, runTask, getTask, isBusy, listTasks, taskView, applyTask, discardTask } from './tasks.js';
import { listModels } from './llm.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('Content-Type harus application/json'));
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function state() {
  return {
    mode: scriptedMode() ? 'scripted' : 'llm',
    provider: usesVultr() ? 'Vultr Serverless Inference' : hostOf(cfg.llm.baseUrl),
    usesVultr: usesVultr(),
    model: cfg.llm.model || null,
    livePublicUrl: cfg.livePublicUrl,
    previewPublicUrl: cfg.previewPublicUrl,
    pluginSlug: cfg.pluginSlug,
    busy: isBusy(),
    limits: { memory: cfg.limits.memory, cpus: cfg.limits.cpus, pids: cfg.limits.pids, agentMaxSteps: cfg.limits.agentMaxSteps },
    allowedDomains: cfg.allowedDomains,
    tasks: listTasks(),
  };
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && p === '/api/models') {
      if (scriptedMode()) return json(res, 200, { models: [], note: 'LLM_API_KEY kosong' });
      return json(res, 200, { models: await listModels() });
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) return json(res, 400, { error: 'Pesan kosong.' });
      if (isBusy()) return json(res, 409, { error: 'Masih ada permintaan yang dikerjakan. Tunggu selesai dulu.' });
      const task = createTask(message);
      runTask(task);
      return json(res, 201, { id: task.id });
    }
    let m = p.match(/^\/api\/tasks\/([a-f0-9]+)(\/(events|apply|discard))?$/);
    if (m) {
      const task = getTask(m[1]);
      if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan.' });
      const action = m[3];
      if (!action && req.method === 'GET') return json(res, 200, taskView(task));
      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        const from = Number(url.searchParams.get('from') || 0);
        task.events.slice(from).forEach(send);
        task.listeners.add(send);
        const hb = setInterval(() => res.write(': hb\n\n'), 15000);
        req.on('close', () => {
          clearInterval(hb);
          task.listeners.delete(send);
        });
        return;
      }
      if (action === 'apply' && req.method === 'POST') {
        await readJson(req);
        return json(res, 200, await applyTask(task));
      }
      if (action === 'discard' && req.method === 'POST') {
        await readJson(req);
        await discardTask(task);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET') {
      const file = p === '/' ? 'index.html' : p.slice(1);
      if (!/^[a-z0-9._-]+$/i.test(file)) return json(res, 404, { error: 'not found' });
      try {
        const data = await fs.readFile(path.join(PUBLIC, file));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(data);
      } catch {
        return json(res, 404, { error: 'not found' });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

const previewHost = hostOf(cfg.previewPublicUrl);
const preview = http.createServer((req, res) => {
  const m = req.url.match(/^\/preview\/([a-f0-9]+)(\/|$|\?)/);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('PressBox preview: tidak ada sandbox di alamat ini.');
  }
  const task = getTask(m[1]);
  if (!task || !task.sandbox || !task.sandbox.alive) {
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="font-family:system-ui;padding:2rem;color:#555"><h2>Sandbox sudah dihancurkan</h2><p>Preview ini tidak tersedia lagi.</p></body>');
  }
  const up = http.request(
    { host: sandboxName(task), port: 8080, path: req.url, method: req.method, headers: { ...req.headers, host: previewHost } },
    (ur) => {
      res.writeHead(ur.statusCode || 502, ur.headers);
      ur.pipe(res);
    },
  );
  up.setTimeout(30000, () => up.destroy(new Error('timeout')));
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Sandbox tidak merespons: ${e.message}`);
  });
  req.pipe(up);
});

const n = await destroyOrphans();
app.listen(cfg.port, () => {
  console.log(`[pressbox] app      ${cfg.publicUrl} (listen :${cfg.port})`);
  console.log(`[pressbox] preview  ${cfg.previewPublicUrl} (listen :${cfg.previewPort})`);
  console.log(`[pressbox] live     ${cfg.livePublicUrl}`);
  console.log(`[pressbox] LLM      ${scriptedMode() ? 'MODE SKRIP (LLM_API_KEY kosong)' : `${cfg.llm.baseUrl} model=${cfg.llm.model}`}`);
  if (n) console.log(`[pressbox] ${n} sandbox yatim dari sesi sebelumnya dihancurkan.`);
});
preview.listen(cfg.previewPort);
