// Task orchestration: one chat request = one sandbox = one changeset.
//
// Lifecycle: cloning -> sandbox -> agent -> gate -> review | blocked | error,
// then review -> applying -> applied | apply_failed, or review -> discarded.
// Every exit path destroys the sandbox.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { cloneProduction, createSandbox, destroySandbox } from './sandbox.js';
import { runAgent } from './agent.js';
import { runGate, recordBaseline } from './gate.js';
import { applyToProduction, productionSnapshot, readServerProfile } from './production.js';

const MAX_MESSAGE_CHARS = 4000;
const tasks = new Map();
const appliedHistory = []; // fed back to the agent so follow-up requests have context
let runningTaskId = null;

export const getTask = (id) => tasks.get(id);
export const isBusy = () => runningTaskId !== null;

/** What the browser may see: no API keys, timers, or listeners. */
export function publicView(task) {
  return {
    id: task.id,
    message: task.message,
    status: task.status,
    createdAt: task.createdAt,
    summary: task.summary || '',
    verdict: task.verdict || null,
    changeset: task.changeset,
    sandbox: task.sandbox ? { name: task.sandbox.name, home: task.sandbox.home, alive: task.sandbox.alive } : null,
    usage: task.usage || null,
    applyResult: task.applyResult || null,
  };
}

/** Only the session that started a task may watch, apply or discard it. */
export const isTaskOwner = (task, sessionToken) => task.ownerToken === (sessionToken || '');

export function createTask(message, apiKey, ownerToken = '') {
  const task = {
    id: crypto.randomBytes(8).toString('hex'),
    message: String(message).slice(0, MAX_MESSAGE_CHARS),
    apiKey,
    ownerToken,
    status: 'queued',
    createdAt: Date.now(),
    events: [],
    listeners: new Set(),
    changeset: { files: {}, commands: [] },
  };
  task.emit = (type, fields = {}) => {
    const event = { seq: task.events.length, t: Date.now(), type, ...fields };
    task.events.push(event);
    for (const listener of task.listeners) listener(event);
  };
  task.log = (kind, text) => task.emit('containment', { kind, text });
  tasks.set(task.id, task);
  return task;
}

function setStatus(task, status) {
  task.status = status;
  task.emit('status', { status });
}

export async function runTask(task) {
  runningTaskId = task.id;
  const deadline = setTimeout(() => {
    task.cancelled = true;
    task.log('limit', `Task time limit of ${Math.round(cfg.limits.taskTimeoutMs / 60000)} minutes reached; the agent was stopped.`);
  }, cfg.limits.taskTimeoutMs);
  try {
    task.productionBefore = await productionSnapshot();
    task.profile = await readServerProfile();
    if (task.profile) task.emit('profile', { profile: task.profile });

    setStatus(task, 'cloning');
    await cloneProduction(task, task.log);
    setStatus(task, 'sandbox');
    await createSandbox(task, task.log);
    await recordBaseline(task);
    task.emit('preview', { url: `${task.sandbox.home}/` });

    setStatus(task, 'agent');
    const outcome = await runAgent(task, task.emit, appliedHistory);
    task.emit('changeset', { changeset: task.changeset });
    if (task.summary) task.emit('summary', { text: task.summary });

    setStatus(task, 'gate');
    task.verdict = await runGate(task, outcome);
    task.emit('verdict', { verdict: task.verdict });

    if (task.verdict.pass) {
      setStatus(task, 'review');
      const ttlMinutes = Math.round(cfg.limits.sandboxTtlMs / 60000);
      task.ttlTimer = setTimeout(() => discardTask(task, `not reviewed within ${ttlMinutes} minutes`), cfg.limits.sandboxTtlMs);
    } else {
      await destroySandbox(task, 'blocked by the gate', task.log);
      await reportProductionUntouched(task);
      setStatus(task, 'blocked');
    }
  } catch (err) {
    task.emit('error', { message: err.message });
    await destroySandbox(task, 'error', task.log).catch((cleanupErr) => task.log('destroy', `Cleanup failed: ${cleanupErr.message}`));
    setStatus(task, 'error');
  } finally {
    clearTimeout(deadline);
    runningTaskId = null;
  }
}

async function reportProductionUntouched(task) {
  const before = task.productionBefore;
  const after = await productionSnapshot();
  const unchanged = before && after.admins === before.admins && after.pluginFiles === before.pluginFiles && after.homeStatus === before.homeStatus;
  task.log(
    'live',
    unchanged
      ? `Production untouched: same administrators (${after.admins}), same ${after.pluginFiles} plugin files, home page HTTP ${after.homeStatus}.`
      : `ATTENTION: production differs from before the task (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}).`,
  );
}

export async function applyTask(task) {
  if (task.status !== 'review' || !task.verdict?.pass) throw new Error('Only a task that passed the gate can be applied.');
  clearTimeout(task.ttlTimer);
  setStatus(task, 'applying');
  let result;
  try {
    result = await applyToProduction(task, task.log);
  } catch (err) {
    result = { ok: false, error: err.message }; // e.g. the backup failed, so nothing was written
  }
  await destroySandbox(task, result.ok ? 'applied to production' : 'apply failed', task.log);
  task.applyResult = result;
  if (result.ok) appliedHistory.push({ message: task.message, summary: task.summary });
  setStatus(task, result.ok ? 'applied' : 'apply_failed');
  task.emit('applied', { result });
  return result;
}

export async function discardTask(task, reason = 'discarded by the site owner') {
  if (task.status !== 'review') return;
  clearTimeout(task.ttlTimer);
  await destroySandbox(task, reason, task.log);
  await reportProductionUntouched(task);
  setStatus(task, 'discarded');
}
