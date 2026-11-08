// Central configuration. Everything comes from env so the same image runs locally and on a Vultr VM.
const env = process.env;

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: Number(env.PORT || 3000),
  previewPort: Number(env.PREVIEW_PORT || 3001),
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  previewPublicUrl: (env.PREVIEW_PUBLIC_URL || 'http://localhost:3001').replace(/\/$/, ''),
  livePublicUrl: (env.LIVE_PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),

  liveContainer: env.LIVE_CONTAINER || 'pressbox-live',
  sandboxImage: env.SANDBOX_IMAGE || 'pressbox-wp:latest',
  sandboxNetwork: env.SANDBOX_NETWORK || 'pb_sandbox',
  workDir: env.WORK_DIR || '/work',
  dataDir: env.DATA_DIR || '/data',

  pluginSlug: env.PLUGIN_SLUG || 'kedai-senja-custom',
  wpRoot: '/var/www/html',

  // LLM: any OpenAI-compatible endpoint. For the hackathon this MUST be Vultr Serverless Inference.
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://api.vultrinference.com/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || '',
    // Only sent when set: Claude 4.7+ (OpenAI-compat endpoint) rejects temperature < 1.
    temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
  },

  limits: {
    memory: env.SANDBOX_MEMORY || '512m',
    cpus: env.SANDBOX_CPUS || '1',
    pids: Number(env.SANDBOX_PIDS || 200),
    cmdTimeoutSec: Number(env.SANDBOX_CMD_TIMEOUT || 30),
    httpTimeoutMs: Number(env.SANDBOX_HTTP_TIMEOUT_MS || 25000),
    agentMaxSteps: Number(env.AGENT_MAX_STEPS || 20),
    taskTimeoutMs: Number(env.TASK_TIMEOUT_MS || 8 * 60 * 1000),
    sandboxTtlMs: Number(env.SANDBOX_TTL_MS || 15 * 60 * 1000),
  },

  // Outbound domains a feature may call once the owner approves them. Empty = nothing allowed.
  allowedDomains: list(env.ALLOWED_DOMAINS),
};

export const scriptedMode = () => !cfg.llm.apiKey;
export const usesVultr = () => /vultrinference\.com/.test(cfg.llm.baseUrl);
export const pluginDir = () => `${cfg.wpRoot}/wp-content/plugins/${cfg.pluginSlug}`;
