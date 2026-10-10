/**
 * DeepSeek is a first-class AI provider (like OpenAI/Anthropic; API-key only,
 * like Google). The live `GET https://api.deepseek.com/models` endpoint requires
 * a Bearer key, so this static list backs the generic model picker; a
 * connection-scoped refresh can add newer IDs without a release.
 *
 * Verified against the official DeepSeek docs on 2026-10-08:
 * context_window = 1_048_576, max_output_tokens = 393_216,
 * effort.supported_levels = ["low", "high", "max"] (default "high").
 * `deepseek-v4-pro` is transitional (requests route to V4.1-Flash until
 * V4.1-Pro launches).
 */
export const DEEPSEEK_MODELS = [
  { id: "deepseek-flash", label: "DeepSeek Flash", context: 1_048_576, vision: true },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", context: 1_048_576, vision: false },
] as const;

export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

/** Paperclip reasoning-effort domain → DeepSeek's `low | high | max`. */
export const DEEPSEEK_EFFORT: Record<string, "low" | "high" | "max"> = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max",
  ultra: "max",
};

/**
 * DeepSeek accepts the full effort domain and normalizes it itself for the
 * OpenAI/Responses formats (see the official thinking-mode mapping), but the
 * Anthropic Messages path documents `low | high | max`. Normalize explicitly so
 * every harness sends an in-domain value.
 */
export function deepseekReasoningEffort(value: unknown): "low" | "high" | "max" | undefined {
  return typeof value === "string" ? DEEPSEEK_EFFORT[value] : undefined;
}

/** DeepSeek speaks a different base URL per protocol; derive it from the harness. */
export function protocolForDeepSeekHarness(
  harness: string,
): "responses" | "messages" | "chat" {
  return harness === "codex_local"
    ? "responses"
    : harness === "claude_local"
      ? "messages"
      : "chat";
}
