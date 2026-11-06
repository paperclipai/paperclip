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
  // Explicit provider namespaces. The namespace of a model id
  // ("openrouter/gpt-4.1-mini") states the provider and is matched against the
  // full model id before any bare-name inference, so a namespaced id is never
  // routed to another vendor because its bare name happens to look like
  // another provider's model.
  ["openrouter/", "openrouter"],
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

/**
 * Model id namespace (the first path segment) -> Hermes provider hints.
 *
 * A namespace is an explicit statement about the vendor that must serve the
 * model, so it is exclusive: the providers listed here are the only correct
 * ones for that namespace. Pairing such a model id with a different provider
 * (or with another vendor's base URL) sends the request to the wrong endpoint
 * and fails as an opaque provider error, so the mismatch is rejected when the
 * agent config is saved.
 *
 * Namespaces that are intentionally absent:
 *   - "anthropic" — an OpenRouter catalog id such as "anthropic/claude-3.5"
 *     is legitimate for provider "openrouter", so the namespace is ambiguous.
 *   - "gemini", "deepseek", "llama", "qwen", "mistral" — these hint at "auto"
 *     (let Hermes decide), not at one vendor.
 */
export const MODEL_NAMESPACE_PROVIDER_HINTS: {
  /** Namespace segment as it appears in the model id. */
  namespace: string;
  /** Hermes providers that may serve this namespace. */
  providers: string[];
  /** Base URL host tokens that belong to this namespace's vendor. */
  hostTokens: string[];
}[] = [
  { namespace: "openrouter", providers: ["openrouter"], hostTokens: ["openrouter"] },
  { namespace: "nous", providers: ["nous"], hostTokens: ["nous"] },
  { namespace: "nousresearch", providers: ["nous"], hostTokens: ["nous"] },
  { namespace: "zai", providers: ["zai"], hostTokens: ["zai", "z.ai", "zhipu"] },
  { namespace: "minimax", providers: ["minimax", "minimax-cn"], hostTokens: ["minimax"] },
  { namespace: "kimi", providers: ["kimi-coding"], hostTokens: ["kimi", "moonshot"] },
  { namespace: "moonshot", providers: ["kimi-coding"], hostTokens: ["kimi", "moonshot"] },
  { namespace: "huggingface", providers: ["huggingface"], hostTokens: ["huggingface", "hf.co"] },
  { namespace: "copilot", providers: ["copilot"], hostTokens: ["copilot"] },
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
