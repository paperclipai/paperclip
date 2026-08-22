/**
 * Official public per-token list pricing, used to estimate an equivalent cost for
 * heartbeat runs billed under a flat-fee subscription (Claude Pro/Max, ChatGPT
 * Plus/Pro/Team, etc.), where the underlying provider reports token usage but no
 * per-call dollar cost.
 *
 * Only exact `provider` + normalized `model` matches are priced. An unmatched model
 * returns `null` rather than guessing at a nearby model's rate, so unsupported models
 * stay `unpriced` instead of being silently mis-costed.
 *
 * Rates are $ per million tokens, captured from provider pricing pages on 2026-08-17:
 * - https://platform.claude.com/docs/en/about-claude/pricing
 * - https://developers.openai.com/api/docs/pricing
 * Re-verify against those pages before adding entries or trusting these for real
 * budget enforcement — provider pricing changes over time.
 */

export interface ModelPriceRate {
  /** $ per 1,000,000 standard input tokens. */
  inputPerMTokUsd: number;
  /** $ per 1,000,000 output tokens. */
  outputPerMTokUsd: number;
  /** $ per 1,000,000 cache-read (cache hit) input tokens. */
  cachedInputPerMTokUsd: number;
}

const MODEL_PRICING_TABLE: Record<string, Record<string, ModelPriceRate>> = {
  anthropic: {
    "claude-sonnet-5": { inputPerMTokUsd: 2, outputPerMTokUsd: 10, cachedInputPerMTokUsd: 0.2 },
    "claude-haiku-4-5": { inputPerMTokUsd: 1, outputPerMTokUsd: 5, cachedInputPerMTokUsd: 0.1 },
  },
  openai: {
    "gpt-5.3-codex": { inputPerMTokUsd: 1.75, outputPerMTokUsd: 14, cachedInputPerMTokUsd: 0.175 },
  },
};

/**
 * Strips a trailing dated/versioned suffix (e.g. `-20260215`, `-latest`) so a
 * fully-qualified model id still matches the family entry in the pricing table.
 */
function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

/**
 * Estimates a cost in whole cents for a subscription-billed run from raw token
 * counts, or returns `null` when the provider/model has no known public rate —
 * callers should keep those runs `unpriced` rather than apply a guessed price.
 */
export function estimateSubscriptionCostCents(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): number | null {
  const provider = input.provider?.trim().toLowerCase();
  const model = input.model?.trim();
  if (!provider || !model) return null;

  const rate = MODEL_PRICING_TABLE[provider]?.[normalizeModelId(model)];
  if (!rate) return null;

  const usd =
    (Math.max(0, input.inputTokens) / 1_000_000) * rate.inputPerMTokUsd +
    (Math.max(0, input.outputTokens) / 1_000_000) * rate.outputPerMTokUsd +
    (Math.max(0, input.cachedInputTokens) / 1_000_000) * rate.cachedInputPerMTokUsd;

  return Math.max(0, Math.round(usd * 100));
}
