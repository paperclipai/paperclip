import type { LlmConfig } from "./schema.js";

// Human-readable label used when prompting for an API key and in health-check
// messages. Keyed by the full provider union so adding a provider forces a
// label to be provided.
export const LLM_PROVIDER_KEY_LABELS: Record<LlmConfig["provider"], string> = {
  claude: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  glm: "Zhipu GLM",
  kimi: "Moonshot Kimi",
};

// OpenAI-compatible base URLs for providers whose keys are validated with
// `GET <baseUrl>/models`. Excludes "claude", which uses the Anthropic Messages
// API in its own branch. Keyed by `Exclude<..., "claude">` so every
// OpenAI-compatible provider must have an endpoint or compilation fails.
export const LLM_OPENAI_COMPAT_BASE_URLS: Record<
  Exclude<LlmConfig["provider"], "claude">,
  string
> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  kimi: "https://api.moonshot.cn/v1",
};