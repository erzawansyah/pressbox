// Runtime configuration. Everything comes from the environment so the same image runs
// on a laptop and on a Vultr VM.
const env = process.env;

const trimSlash = (url) => url.replace(/\/$/, '');
const csv = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: Number(env.PORT || 3000),
  previewPort: Number(env.PREVIEW_PORT || 3001),
  publicUrl: trimSlash(env.PUBLIC_URL || 'http://localhost:8300'),
  previewPublicUrl: trimSlash(env.PREVIEW_PUBLIC_URL || 'http://localhost:8301'),
  livePublicUrl: trimSlash(env.LIVE_PUBLIC_URL || 'http://localhost:8080'),
  repoUrl: env.REPO_URL || 'https://github.com/erzawansyah/pressbox',

  liveContainer: env.LIVE_CONTAINER || 'pressbox-live',
  sandboxImage: env.SANDBOX_IMAGE || 'pressbox-wp:latest',
  sandboxNetwork: env.SANDBOX_NETWORK || 'pb_sandbox',
  workDir: env.WORK_DIR || '/work',

  pluginSlug: env.PLUGIN_SLUG || 'senja-coffee',
  wpRoot: '/var/www/html',

  // Any OpenAI-compatible endpoint works; the hackathon build uses Vultr Serverless Inference.
  llm: {
    baseUrl: trimSlash(env.LLM_BASE_URL || 'https://api.vultrinference.com/v1'),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || '',
    // Only sent when set: Claude 4.7+ on its OpenAI-compatible endpoint rejects temperature < 1.
    temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : undefined,
  },

  access: {
    // Shared with judges in the submission. Unlocks a pooled quota on the operator's key.
    judgeCode: env.JUDGE_ACCESS_CODE || '',
    judgeTaskLimit: Number(env.JUDGE_TASK_LIMIT || 40),
    // Visitors without a code can bring their own Vultr Serverless Inference key.
    allowOwnKey: env.ALLOW_OWN_KEY !== 'false',
  },

  limits: {
    memory: env.SANDBOX_MEMORY || '512m',
    cpus: env.SANDBOX_CPUS || '1',
    pids: Number(env.SANDBOX_PIDS || 200),
    cmdTimeoutSec: Number(env.SANDBOX_CMD_TIMEOUT || 30),
    httpTimeoutMs: Number(env.SANDBOX_HTTP_TIMEOUT_MS || 25000),
    agentMaxSteps: Number(env.AGENT_MAX_STEPS || 24),
    taskTimeoutMs: Number(env.TASK_TIMEOUT_MS || 8 * 60 * 1000),
    sandboxTtlMs: Number(env.SANDBOX_TTL_MS || 15 * 60 * 1000),
  },

  // Outbound domains a feature may call once the owner approves them. Empty means none.
  allowedDomains: csv(env.ALLOWED_DOMAINS),
};

// No operator key: the agent replays fixed scenarios so the pipeline can be tested offline.
export const scriptedMode = () => !cfg.llm.apiKey;
export const usesVultr = () => /vultrinference\.com/.test(cfg.llm.baseUrl);
export const pluginDir = () => `${cfg.wpRoot}/wp-content/plugins/${cfg.pluginSlug}`;
