// PressBox control plane HTTP servers.
//   :3000  landing page (/), chat app (/app), JSON API and event streams (/api/*)
//   :3001  preview proxy to sandboxes, deliberately a different origin from the app so
//          JavaScript running inside a sandbox preview cannot touch the control UI.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, scriptedMode, usesVultr } from './config.js';
import { hostOf } from './proc.js';
import { destroyOrphanSandboxes, sandboxName } from './sandbox.js';
import { createTask, runTask, getTask, isBusy, listTasks, publicView, applyTask, discardTask } from './tasks.js';
import { readServerProfile } from './production.js';
import { listModels } from './llm.js';
import { accessRequired, authorizeTask, describeSession, getSession, openSession } from './access.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const PAGE_ROUTES = { '/': 'index.html', '/app': 'app.html' };
const MAX_BODY_BYTES = 64_000;
const SSE_HEARTBEAT_MS = 15_000;

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Requiring a JSON content type makes every write endpoint a non-simple request, so a
// page on another origin (such as a sandbox preview) cannot trigger it without CORS.
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/.test(req.headers['content-type'] || '')) return reject(new Error('Content-Type must be application/json'));
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const sessionToken = (req) => req.headers['x-pressbox-session'] || '';

async function appState(req) {
  return {
    mode: scriptedMode() ? 'scripted' : 'llm',
    provider: usesVultr() ? 'Vultr Serverless Inference' : hostOf(cfg.llm.baseUrl),
    usesVultr: usesVultr(),
    model: cfg.llm.model || null,
    livePublicUrl: cfg.livePublicUrl,
    previewPublicUrl: cfg.previewPublicUrl,
    repoUrl: cfg.repoUrl,
    pluginSlug: cfg.pluginSlug,
    busy: isBusy(),
    access: {
      required: accessRequired(),
      ownKeyAllowed: cfg.access.allowOwnKey,
      judgeCodeConfigured: Boolean(cfg.access.judgeCode),
      session: describeSession(getSession(sessionToken(req))),
    },
    limits: { memory: cfg.limits.memory, cpus: cfg.limits.cpus, pids: cfg.limits.pids, agentMaxSteps: cfg.limits.agentMaxSteps },
    allowedDomains: cfg.allowedDomains,
    profile: await readServerProfile(),
    tasks: listTasks(),
  };
}

function streamEvents(req, res, task, fromSeq) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  task.events.slice(fromSeq).forEach(send);
  task.listeners.add(send);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    task.listeners.delete(send);
  });
}

async function serveStatic(res, file) {
  try {
    const content = await fs.readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    sendJson(res, 404, { error: 'not found' });
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/health') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' && route === '/api/state') return sendJson(res, 200, await appState(req));
  if (req.method === 'GET' && route === '/api/models') {
    return sendJson(res, 200, scriptedMode() ? { models: [], note: 'LLM_API_KEY is not set' } : { models: await listModels() });
  }
  if (req.method === 'POST' && route === '/api/session') return sendJson(res, 200, openSession(await readJson(req)));
  if (req.method === 'POST' && route === '/api/tasks') {
    const { message = '' } = await readJson(req);
    if (!message.trim()) return sendJson(res, 400, { error: 'The message is empty.' });
    if (isBusy()) return sendJson(res, 409, { error: 'Another request is still running. Please wait for it to finish.' });
    const apiKey = authorizeTask(sessionToken(req));
    const task = createTask(message.trim(), apiKey);
    runTask(task);
    return sendJson(res, 201, { id: task.id });
  }

  const match = route.match(/^\/api\/tasks\/([a-f0-9]+)(?:\/(events|apply|discard))?$/);
  if (!match) return sendJson(res, 404, { error: 'not found' });
  const task = getTask(match[1]);
  if (!task) return sendJson(res, 404, { error: 'Task not found.' });
  const action = match[2];
  if (!action && req.method === 'GET') return sendJson(res, 200, publicView(task));
  if (action === 'events' && req.method === 'GET') return streamEvents(req, res, task, Number(url.searchParams.get('from') || 0));
  if (action === 'apply' && req.method === 'POST') {
    await readJson(req);
    return sendJson(res, 200, await applyTask(task));
  }
  if (action === 'discard' && req.method === 'POST') {
    await readJson(req);
    await discardTask(task);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

const appServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (PAGE_ROUTES[url.pathname]) return await serveStatic(res, PAGE_ROUTES[url.pathname]);
    const file = url.pathname.slice(1);
    if (!/^[a-z0-9._-]+$/i.test(file)) return sendJson(res, 404, { error: 'not found' });
    return await serveStatic(res, file);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

const previewHost = hostOf(cfg.previewPublicUrl);
const previewServer = http.createServer((req, res) => {
  const match = req.url.match(/^\/preview\/([a-f0-9]+)(\/|$|\?)/);
  if (!match) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('PressBox preview: no sandbox at this address.');
  }
  const task = getTask(match[1]);
  if (!task?.sandbox?.alive) {
    res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="font-family:system-ui;padding:2rem;color:#555"><h2>This sandbox has been destroyed</h2><p>The preview is no longer available.</p></body>');
  }
  const upstream = http.request(
    { host: sandboxName(task), port: 8080, path: req.url, method: req.method, headers: { ...req.headers, host: previewHost } },
    (sandboxRes) => {
      res.writeHead(sandboxRes.statusCode || 502, sandboxRes.headers);
      sandboxRes.pipe(res);
    },
  );
  upstream.setTimeout(30000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`The sandbox did not respond: ${err.message}`);
  });
  req.pipe(upstream);
});

const orphans = await destroyOrphanSandboxes();
appServer.listen(cfg.port, () => {
  console.log(`[pressbox] app      ${cfg.publicUrl} (listening on :${cfg.port})`);
  console.log(`[pressbox] preview  ${cfg.previewPublicUrl} (listening on :${cfg.previewPort})`);
  console.log(`[pressbox] live     ${cfg.livePublicUrl}`);
  console.log(`[pressbox] LLM      ${scriptedMode() ? 'SCRIPTED MODE (LLM_API_KEY not set)' : `${cfg.llm.baseUrl} model=${cfg.llm.model}`}`);
  console.log(`[pressbox] access   ${accessRequired() ? `judge code ${cfg.access.judgeCode ? 'set' : 'NOT SET'}, own keys ${cfg.access.allowOwnKey ? 'allowed' : 'off'}` : 'open (scripted mode)'}`);
  if (orphans) console.log(`[pressbox] destroyed ${orphans} orphaned sandboxes from a previous run.`);
});
previewServer.listen(cfg.previewPort);
