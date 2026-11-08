// Who may spend inference tokens on the public demo.
//
// A judge code unlocks a pooled quota on the operator's Vultr key. Anyone else can bring
// their own Vultr Serverless Inference key, which lives only in this process's memory for
// the session: never written to disk, never logged, never passed into a sandbox.
import crypto from 'node:crypto';
import { cfg, scriptedMode } from './config.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let judgeTasksUsed = 0;

export const accessRequired = () => !scriptedMode();

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Opens a session from a judge code or a visitor's own key. An own key is tried with a
 * one-token completion first, so a made-up key cannot occupy the single task slot.
 * `verifyKey` is injectable for tests.
 */
export async function openSession({ code, apiKey }, verifyKey = verifyInferenceKey) {
  if (code) {
    if (!cfg.access.judgeCode || !sameSecret(code.trim(), cfg.access.judgeCode)) throw new Error('That access code is not valid.');
    return createSession({ kind: 'judge' });
  }
  if (apiKey) {
    if (!cfg.access.allowOwnKey) throw new Error('Own keys are disabled on this deployment.');
    const key = apiKey.trim();
    if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(key)) throw new Error('That does not look like an API key.');
    if (!(await verifyKey(key))) throw new Error('Vultr Serverless Inference did not accept that key.');
    return createSession({ kind: 'own-key', apiKey: key });
  }
  throw new Error('Enter an access code or your own Vultr Serverless Inference key.');
}

async function verifyInferenceKey(key) {
  try {
    const res = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.llm.model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.ok;
  } catch {
    return false; // network failure or timeout: treat as not verified
  }
}

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
}, SWEEP_INTERVAL_MS).unref();

function createSession(fields) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ...fields, expiresAt: Date.now() + SESSION_TTL_MS });
  return { token, ...describeSession(sessions.get(token)) };
}

export function getSession(token) {
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function describeSession(session) {
  if (!session) return { kind: 'none' };
  if (session.kind === 'judge') return { kind: 'judge', remaining: Math.max(0, cfg.access.judgeTaskLimit - judgeTasksUsed) };
  return { kind: 'own-key' };
}

// Returns the API key a new task should use, or throws if the session may not start one.
export function authorizeTask(token) {
  if (scriptedMode()) return undefined;
  const session = getSession(token);
  if (!session) throw new Error('Unlock the agent first: enter the judge access code or your own Vultr key.');
  if (session.kind === 'own-key') return session.apiKey;
  if (judgeTasksUsed >= cfg.access.judgeTaskLimit) throw new Error('The judge quota for this demo is used up. You can still continue with your own Vultr key.');
  judgeTasksUsed += 1;
  return cfg.llm.apiKey;
}
