/**
 * Anthropic model pricing used to compute equivalent API cost for subscription
 * runs (where the CLI does not report total_cost_usd).
 *
 * Cache reads are billed at 10% of the input token price.
 * Cache writes are billed at 125% of the input token price.
 *
 * Architectural constraint: the Paperclip CLI owns all Anthropic API calls, so
 * metadata.user_id tagging is not feasible. Per-agent reconciliation against
 * the Anthropic usage report is therefore deferred until tagging lands.
 * Reconciliation currently operates at company (org) level only.
 */

export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
};

export type ModelPricing = {
  inputPerMtok: number;
  outputPerMtok: number;
};

// USD per million tokens
export const ANTHROPIC_MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": { inputPerMtok: 15, outputPerMtok: 75 },
  "claude-opus-4-5": { inputPerMtok: 15, outputPerMtok: 75 },
  "claude-sonnet-4-5": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
  "claude-haiku-4-5-20251001": { inputPerMtok: 1, outputPerMtok: 5 },
};

/**
 * Resolve pricing for a model string. Prefix-matches versioned model IDs
 * (e.g. "claude-opus-4-5-20251001"). Falls back to Opus rates on unknown
 * models — conservative choice that avoids under-counting.
 */
export function resolveModelPricing(model: string): ModelPricing {
  const normalized = model.toLowerCase().trim();
  if (ANTHROPIC_MODEL_PRICING[normalized]) return ANTHROPIC_MODEL_PRICING[normalized]!;
  for (const [key, pricing] of Object.entries(ANTHROPIC_MODEL_PRICING)) {
    if (normalized.startsWith(key)) return pricing;
  }
  return { inputPerMtok: 15, outputPerMtok: 75 };
}

/**
 * Convert token counts to whole cents using Anthropic list pricing.
 * Returns a non-negative integer (cents).
 */
export function computeEquivalentCostCents(usage: TokenUsage, model: string): number {
  const p = resolveModelPricing(model);
  const cents =
    (usage.inputTokens / 1_000_000) * p.inputPerMtok * 100 +
    (usage.cachedInputTokens / 1_000_000) * p.inputPerMtok * 0.1 * 100 +
    (usage.cacheCreationInputTokens / 1_000_000) * p.inputPerMtok * 1.25 * 100 +
    (usage.outputTokens / 1_000_000) * p.outputPerMtok * 100;
  return Math.max(0, Math.round(cents));
}

/**
 * Compute drift percentage between Paperclip-recorded and Anthropic-reported spend.
 * Returns 0 when both values are zero.
 */
export function calculateDriftPct(paperclipCents: number, anthropicCents: number): number {
  if (anthropicCents > 0) {
    return (Math.abs(paperclipCents - anthropicCents) / anthropicCents) * 100;
  }
  if (paperclipCents > 0) return 100;
  return 0;
}
