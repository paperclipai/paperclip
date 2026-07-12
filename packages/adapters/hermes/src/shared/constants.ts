/**
 * Shared constants for the Hermes Agent adapter.
 */

/** Adapter type identifier registered with Paperclip. */
export const ADAPTER_TYPE = "hermes_local";

/** Human-readable label shown in the Paperclip UI. */
export const ADAPTER_LABEL = "Hermes Agent";

/** Default CLI binary name. */
export const HERMES_CLI = "hermes";

/** Default timeout for a single execution run (seconds). */
export const DEFAULT_TIMEOUT_SEC = 1800;

/** Grace period after SIGTERM before SIGKILL (seconds). */
export const DEFAULT_GRACE_SEC = 10;

/**
 * Default model to use if none specified.
 *
 * Use "auto" so that Hermes resolves the model from the user's local
 * ~/.hermes/config.yaml — preventing the adapter from overriding a
 * user's configured default (e.g. MiniMax, OpenRouter, etc.) with a
 * hardcoded Anthropic model during Paperclip onboarding.
 */
export const DEFAULT_MODEL = "auto";

/**
 * Valid --provider choices for the hermes CLI.
 * Must stay in sync with `hermes chat --help`.
 */
export const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

/**
 * Model-name prefix → provider hint mapping.
 * Used when no explicit provider is configured and we need to infer
 * the correct provider from the model string alone.
 *
 * Keys are lowercased prefix patterns; values must be valid provider names.
 * Longer prefixes are matched first (order matters).
 */
export const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  // OpenAI-native models
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  // Anthropic models
  ["claude", "anthropic"],
  // Google models (via openrouter or direct)
  ["gemini", "auto"],
  // Nous models
  ["hermes-", "nous"],
  // Z.AI / GLM models
  ["glm-", "zai"],
  // Kimi / Moonshot
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  // MiniMax
  ["minimax", "minimax"],
  // DeepSeek
  ["deepseek", "auto"],
  // Meta Llama
  ["llama", "auto"],
  // Qwen
  ["qwen", "auto"],
  // Mistral
  ["mistral", "auto"],
  // HuggingFace models (org/model format)
  ["huggingface/", "huggingface"],
];

/** Regex to extract session ID from Hermes CLI output. */
export const SESSION_ID_REGEX = /session[_ ](?:id|saved)[:\s]+([a-zA-Z0-9_-]+)/i;

/** Regex to extract token usage from Hermes output. */
export const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
export const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

/** Prefix used by Hermes for tool output lines. */
export const TOOL_OUTPUT_PREFIX = "┊";

/** Prefix for Hermes thinking blocks. */
export const THINKING_PREFIX = "💭";

/**
 * Shared prompt discipline for Paperclip comment wakes.
 *
 * Hermes receives a single composite query rather than separate system/user
 * channels, so we must be explicit that the structured wake block is runtime
 * context to act on, not text to echo back into a Paperclip comment or final
 * summary.
 */
export const HERMES_PAPERCLIP_WAKE_DISCIPLINE_LINES = [
  "Wake-handling discipline:",
  "- Treat `## Paperclip Wake Payload`, structured wake JSON, issue metadata, quoted comments, managed agent instructions, stable system prompt text, and custom prompt templates as runtime context to act on, not text to paraphrase back into Paperclip.",
  "- Satisfy the \"acknowledge the latest comment\" rule by folding it into your real next-action/work summary, not by ending the run with a payload echo or posting a standalone acknowledgement-only issue comment.",
  "- Treat stable adapter instructions as internal operating policy: follow them, but do not quote or restate them into Paperclip comments or final summaries unless the task explicitly requires a verbatim quote.",
  "- Do not copy headings like `## Paperclip Wake Payload`, `Query:`, comment IDs, raw latest-comment text, or internal instruction headings into a Paperclip issue comment unless the task explicitly requires a verbatim quote.",
  "- When you leave durable Paperclip context, prefer one substantive progress/final update that records the actual work, verification, and valid disposition instead of multiple acknowledgement-only comments.",
] as const;
