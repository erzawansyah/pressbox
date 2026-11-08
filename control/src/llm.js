// OpenAI-compatible chat client. The hackathon deployment points it at Vultr Serverless Inference.
import { cfg } from './config.js';

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 8000;

/**
 * One chat-completions call with tool definitions. `apiKey` overrides the operator key
 * when a visitor brought their own.
 */
export async function chatCompletion(messages, tools, apiKey = cfg.llm.apiKey) {
  const res = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model,
      messages,
      tools,
      tool_choice: 'auto',
      ...(cfg.llm.temperature !== undefined ? { temperature: cfg.llm.temperature } : {}),
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.text();
  if (res.status === 401) throw new Error('The inference API rejected the key (401). Check that it is a Vultr Serverless Inference key.');
  if (!res.ok) throw new Error(`Inference API ${res.status}: ${body.slice(0, 400)}`);
  const completion = JSON.parse(body);
  const message = completion.choices?.[0]?.message;
  if (!message) throw new Error(`Inference API returned no message: ${body.slice(0, 300)}`);
  return { message, usage: completion.usage || null };
}

export async function listModels() {
  const res = await fetch(`${cfg.llm.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.llm.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`models ${res.status}`);
  return ((await res.json()).data || []).map((model) => model.id);
}
