// Task orchestration: one chat request = one sandbox = one changeset.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { cloneLive, createSandbox, destroySandbox } from './sandbox.js';
import { runAgent } from './agent.js';
import { runGate, snapshotBefore } from './gate.js';
import { applyToLive, liveSnapshot } from './live.js';

const tasks = new Map();
const history = []; // applied requests, fed back to the agent as context
let running = null;

export const getTask = (id) => tasks.get(id);
export const isBusy = () => !!running;
export const listTasks = () => [...tasks.values()].map(taskView);

export function taskView(t) {
  return {
    id: t.id,
    message: t.message,
    status: t.status,
    createdAt: t.createdAt,
    summary: t.summary || '',
    verdict: t.verdict || null,
    changeset: t.changeset,
    sandbox: t.sandbox ? { name: t.sandbox.name, home: t.sandbox.home, alive: t.sandbox.alive } : null,
    usage: t.usage || null,
    applyResult: t.applyResult || null,
  };
}

function makeEmitter(task) {
  return (type, data = {}) => {
    const ev = { seq: task.events.length, t: Date.now(), type, ...data };
    task.events.push(ev);
    for (const fn of task.listeners) fn(ev);
  };
}

export function createTask(message) {
  const task = {
    id: crypto.randomBytes(5).toString('hex'),
    message: String(message).slice(0, 4000),
    status: 'queued',
    createdAt: Date.now(),
    events: [],
    listeners: new Set(),
    changeset: { files: {}, commands: [] },
  };
  task.emit = makeEmitter(task);
  task.log = (kind, text) => task.emit('containment', { kind, text });
  tasks.set(task.id, task);
  return task;
}

const setStatus = (task, status) => {
  task.status = status;
  task.emit('status', { status });
};

export async function runTask(task) {
  running = task.id;
  const timer = setTimeout(() => {
    task.cancelled = true;
    task.log('limit', `Batas waktu tugas ${Math.round(cfg.limits.taskTimeoutMs / 60000)} menit tercapai; agen dihentikan.`);
  }, cfg.limits.taskTimeoutMs);
  try {
    task.liveBefore = await liveSnapshot();
    setStatus(task, 'cloning');
    await cloneLive(task, task.log);
    setStatus(task, 'sandbox');
    await createSandbox(task, task.log);
    await snapshotBefore(task);
    task.emit('preview', { url: `${task.sandbox.home}/` });

    setStatus(task, 'agent');
    const result = await runAgent(task, task.emit, history);
    task.emit('changeset', { changeset: task.changeset });
    if (task.summary) task.emit('summary', { text: task.summary });

    setStatus(task, 'gate');
    task.verdict = await runGate(task, result);
    task.emit('verdict', { verdict: task.verdict });

    if (task.verdict.pass) {
      setStatus(task, 'review');
      task.ttlTimer = setTimeout(() => discardTask(task, `tidak ditinjau dalam ${Math.round(cfg.limits.sandboxTtlMs / 60000)} menit`), cfg.limits.sandboxTtlMs);
    } else {
      await destroySandbox(task, 'diblokir gerbang', task.log);
      await reportLiveUntouched(task);
      setStatus(task, 'blocked');
    }
  } catch (e) {
    task.emit('error', { message: e.message });
    await destroySandbox(task, 'error', task.log).catch(() => {});
    setStatus(task, 'error');
  } finally {
    clearTimeout(timer);
    running = null;
  }
}

async function reportLiveUntouched(task) {
  const after = await liveSnapshot();
  const b = task.liveBefore;
  const same = b && after.admins === b.admins && after.pluginFiles === b.pluginFiles && after.homeStatus === b.homeStatus;
  task.log(
    'live',
    same
      ? `Situs live tidak tersentuh: admin sama (${after.admins}), ${after.pluginFiles} file plugin sama, beranda HTTP ${after.homeStatus}.`
      : `PERHATIAN: kondisi live berbeda dari sebelum tugas (sebelum ${JSON.stringify(b)}, sesudah ${JSON.stringify(after)}).`,
  );
}

export async function applyTask(task) {
  if (task.status !== 'review' || !task.verdict?.pass) throw new Error('Hanya tugas berstatus LOLOS yang bisa diterapkan.');
  clearTimeout(task.ttlTimer);
  setStatus(task, 'applying');
  const res = await applyToLive(task, task.log);
  task.applyResult = res;
  await destroySandbox(task, res.ok ? 'diterapkan ke live' : 'penerapan gagal', task.log);
  if (res.ok) {
    history.push({ message: task.message, summary: task.summary });
    setStatus(task, 'applied');
  } else {
    setStatus(task, 'apply_failed');
  }
  task.emit('applied', { result: res });
  return res;
}

export async function discardTask(task, reason = 'dibuang pemilik situs') {
  if (!['review'].includes(task.status)) return;
  clearTimeout(task.ttlTimer);
  await destroySandbox(task, reason, task.log);
  await reportLiveUntouched(task);
  setStatus(task, 'discarded');
}
