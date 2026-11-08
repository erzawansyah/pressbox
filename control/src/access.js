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

export function openSession({ code, apiKey }) {
  if (code) {
    if (!cfg.access.judgeCode || !sameSecret(code.trim(), cfg.access.judgeCode)) throw new Error('That access code is not valid.');
    return createSession({ kind: 'judge' });
  }
  if (apiKey) {
    if (!cfg.access.allowOwnKey) throw new Error('Own keys are disabled on this deployment.');
    if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(apiKey.trim())) throw new Error('That does not look like an API key.');
    return createSession({ kind: 'own-key', apiKey: apiKey.trim() });
  }
  throw new Error('Enter an access code or your own Vultr Serverless Inference key.');
}

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
