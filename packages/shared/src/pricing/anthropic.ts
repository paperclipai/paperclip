/**
 * Anthropic model pricing constants used for cost telemetry.
 *
 * Rates are in USD per million tokens.
 *
 * TODO: keep these in sync with official Anthropic pricing page:
 *   https://www.anthropic.com/pricing#anthropic-api
 *
 * Last verified: 2026-04-20 against public Anthropic pricing page.
 * Update this file whenever Anthropic publishes new rates.
 */

export interface AnthropicModelRates {
  /** USD per million input tokens (non-cached). */
  inputPerMillion: number;
  /** USD per million cache-read input tokens (prompt cache hit). */
  cachedInputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
}

/**
 * Pricing table keyed by canonical model slug.
 * Partial slugs (without date suffix) are used so that minor version bumps
 * ("claude-opus-4-7-20251001") still resolve via the prefix lookup in
 * {@link resolveModelRates}.
 *
 * All values are USD per million tokens.
 */
const MODEL_RATES: Record<string, AnthropicModelRates> = {
  // Claude Opus 4.7 — https://www.anthropic.com/pricing#anthropic-api
  "claude-opus-4-7": {
    inputPerMillion: 15.0,
    cachedInputPerMillion: 1.5,
    outputPerMillion: 75.0,
  },
  // Claude Sonnet 4.6 — https://www.anthropic.com/pricing#anthropic-api
  "claude-sonnet-4-6": {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
  },
  // Claude Sonnet 4 (alias used by some CLI versions)
  "claude-sonnet-4": {
    inputPerMillion: 3.0,
    cachedInputPerMillion: 0.3,
    outputPerMillion: 15.0,
  },
  // Claude Opus 4 (alias used by some CLI versions)
  "claude-opus-4": {
    inputPerMillion: 15.0,
    cachedInputPerMillion: 1.5,
    outputPerMillion: 75.0,
  },
  // Claude Haiku 3.5 — lower tier, included for completeness
  "claude-haiku-3-5": {
    inputPerMillion: 0.8,
    cachedInputPerMillion: 0.08,
    outputPerMillion: 4.0,
  },
};

/**
 * Normalise a model ID to a lookup-friendly form:
 * lower-case, replace underscores with hyphens.
 */
function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/_/g, "-");
}

/**
 * Resolve pricing rates for a given model identifier.
 *
 * Lookup strategy (applied after normalisation):
 *   1. Exact match on the full slug.
 *   2. Prefix match — the table key is a prefix of the supplied model id,
 *      longest-matching prefix wins. This handles dated suffixes like
 *      "claude-opus-4-7-20251001".
 *
 * Returns `null` when no pricing data is available for the model.
 */
export function resolveModelRates(model: string): AnthropicModelRates | null {
  const norm = normalizeModelId(model);

  // 1. Exact match
  if (MODEL_RATES[norm]) return MODEL_RATES[norm];

  // 2. Longest-prefix match
  let bestKey = "";
  let bestRates: AnthropicModelRates | null = null;
  for (const [key, rates] of Object.entries(MODEL_RATES)) {
    if (norm.startsWith(key) && key.length > bestKey.length) {
      bestKey = key;
      bestRates = rates;
    }
  }
  return bestRates;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/**
 * Compute the cost in **integer cents** for a completed model invocation.
 *
 * Returns 0 when:
 *   - The model is unrecognised (no pricing data available).
 *   - All token counts are zero.
 *
 * The result is rounded to the nearest cent; a minimum of 0 is enforced.
 */
export function costCents(model: string, usage: TokenUsage): number {
  const rates = resolveModelRates(model);
  if (!rates) return 0;

  const input = Math.max(0, usage.inputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);

  const usd =
    (input / 1_000_000) * rates.inputPerMillion +
    (cached / 1_000_000) * rates.cachedInputPerMillion +
    (output / 1_000_000) * rates.outputPerMillion;

  return Math.max(0, Math.round(usd * 100));
}
