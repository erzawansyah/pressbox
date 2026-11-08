// OpenAI-compatible chat client. In the hackathon build this points at Vultr Serverless Inference.
import { cfg } from './config.js';

export async function chatCompletion(messages, tools) {
  const res = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.llm.apiKey}` },
    body: JSON.stringify({
      model: cfg.llm.model,
      messages,
      tools,
      tool_choice: 'auto',
      ...(cfg.llm.temperature !== undefined ? { temperature: cfg.llm.temperature } : {}),
      max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error(`Respons LLM tanpa pesan: ${text.slice(0, 300)}`);
  return { message: msg, usage: data.usage || null };
}

export async function listModels() {
  const res = await fetch(`${cfg.llm.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${cfg.llm.apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}
