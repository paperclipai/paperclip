/**
 * USD pricing for OpenAI token usage.
 *
 * Used to attribute API-equivalent USD cost to OpenAI/Codex runs that execute
 * under OAuth/subscription auth, where the Codex CLI reports no `costUsd`. See
 * docs/superpowers/specs/2026-06-13-openai-subscription-api-pricing-design.md.
 *
 * Prices are USD per 1M tokens (OpenAI public API pricing, June 2026). Adjust
 * these constants when OpenAI changes its rates. Cached rates without an
 * official figure use 10% of the input rate (OpenAI's standard cache discount).
 */

export interface OpenAiTokenUsage {
  model?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface OpenAiModelRate {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M cached input tokens. */
  cached: number;
  /** USD per 1M output tokens. */
  output: number;
}

/**
 * Model -> USD-per-1M-token rates. Keys are matched against the run's model id
 * by longest matching prefix, so `gpt-5.3-codex-spark` resolves to the
 * `gpt-5.3-codex` entry.
 */
export const OPENAI_TOKEN_PRICING: Record<string, OpenAiModelRate> = {
  // Subscription Codex default runs as gpt-5.5; billed here at the Batch rate
  // (50% off the 5.00 / 0.50 / 30.00 standard rate). Also the fallback below.
  "gpt-5.5": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15.0 },
  "gpt-5.3-codex": { input: 2.0, cached: 0.2, output: 14.0 },
  "gpt-5.2-codex": { input: 2.0, cached: 0.2, output: 14.0 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2.0 },
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10.0 },
  "o4-mini": { input: 1.1, cached: 0.275, output: 4.4 },
  "o3-mini": { input: 1.1, cached: 0.275, output: 4.4 },
  "o3": { input: 2.0, cached: 0.5, output: 8.0 },
};

/** Rate used for empty or unrecognized OpenAI models. */
export const OPENAI_PRICING_FALLBACK_KEY = "gpt-5.5";

// Longest key first so prefix matching prefers the most specific entry
// (e.g. `gpt-5-mini` over `gpt-5`, `gpt-5.3-codex` over nothing).
const PRICING_KEYS_BY_SPECIFICITY = Object.keys(OPENAI_TOKEN_PRICING).sort(
  (a, b) => b.length - a.length,
);

function resolveRate(model: string | null | undefined): OpenAiModelRate {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (normalized) {
    for (const key of PRICING_KEYS_BY_SPECIFICITY) {
      if (normalized === key || normalized.startsWith(`${key}-`) || normalized.startsWith(`${key}.`)) {
        return OPENAI_TOKEN_PRICING[key];
      }
    }
  }
  return OPENAI_TOKEN_PRICING[OPENAI_PRICING_FALLBACK_KEY];
}

/**
 * Computes the API-equivalent USD cost of OpenAI token usage, in whole cents.
 * Cached tokens are subtracted from input tokens before applying the input
 * rate. Returns 0 when there is no usage.
 */
export function priceOpenAiUsageCents(usage: OpenAiTokenUsage): number {
  const inputTokens = Math.max(0, Math.floor(usage.inputTokens));
  const cachedInputTokens = Math.max(0, Math.floor(usage.cachedInputTokens));
  const outputTokens = Math.max(0, Math.floor(usage.outputTokens));
  if (inputTokens === 0 && cachedInputTokens === 0 && outputTokens === 0) {
    return 0;
  }

  const rate = resolveRate(usage.model);
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const usd =
    (uncachedInput / 1_000_000) * rate.input +
    (cachedInputTokens / 1_000_000) * rate.cached +
    (outputTokens / 1_000_000) * rate.output;

  return Math.max(0, Math.round(usd * 100));
}
