// Static, calibratable model -> price map used to impute an economic cost for
// runs that carry no billed cost. Subscription runs (e.g. Claude Max) report
// costCents=0, so without imputation every budget/finance metric reads zero even
// while millions of tokens are consumed. Rates are US cents per 1,000,000 tokens
// and are DEFAULTS meant to be tuned by an operator as provider pricing changes
// — they are a knob, not ground truth. Cached input reads are priced far below
// uncached input.
//
// Matching is by lowercase substring against the model id, first match wins, so
// order entries most-specific first. The final entry (match: "") is the
// fallback used for unknown models.

export interface ModelPrice {
  /** lowercase substring matched against the model id; "" matches anything (fallback). */
  readonly match: string;
  /** US cents per 1M uncached input tokens. */
  readonly inputPer1M: number;
  /** US cents per 1M cached input (read) tokens. */
  readonly cachedInputPer1M: number;
  /** US cents per 1M output tokens. */
  readonly outputPer1M: number;
}

// Ordered most-specific first. Values approximate public Anthropic list prices
// (USD/1M x 100 = cents/1M) as of 2026-08; edit these as pricing changes.
// ponytail: static default table; swap for a provider-fed source only if pricing
// churn makes hand-editing painful.
export const MODEL_PRICING: readonly ModelPrice[] = [
  { match: "opus", inputPer1M: 1500, cachedInputPer1M: 150, outputPer1M: 7500 },
  { match: "haiku", inputPer1M: 80, cachedInputPer1M: 8, outputPer1M: 400 },
  { match: "sonnet", inputPer1M: 300, cachedInputPer1M: 30, outputPer1M: 1500 },
  // Fallback for unknown models: neutral mid-tier (sonnet-like).
  { match: "", inputPer1M: 300, cachedInputPer1M: 30, outputPer1M: 1500 },
];

const FALLBACK_PRICE: ModelPrice =
  MODEL_PRICING.find((price) => price.match === "") ?? MODEL_PRICING[MODEL_PRICING.length - 1];

export function resolveModelPricing(model: string | null | undefined): ModelPrice {
  const id = (model ?? "").toLowerCase();
  for (const price of MODEL_PRICING) {
    if (price.match === "" || id.includes(price.match)) return price;
  }
  return FALLBACK_PRICE;
}

export interface TokenUsage {
  model?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

/** Imputed cost in integer US cents for the given token usage. */
export function imputeCostCents(usage: TokenUsage): number {
  const price = resolveModelPricing(usage.model);
  const input = Math.max(0, usage.inputTokens ?? 0);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cents =
    (input / 1_000_000) * price.inputPer1M +
    (cached / 1_000_000) * price.cachedInputPer1M +
    (output / 1_000_000) * price.outputPer1M;
  return Math.round(cents);
}

export interface CostEventLike extends TokenUsage {
  costCents?: number | null;
}

/**
 * The economic "truth" for a cost event: the real billed cost when one was
 * reported (metered API runs), otherwise the imputed token cost (subscription
 * runs report costCents=0). Reused by cost views and budget enforcement so both
 * see a non-zero number for subscription usage.
 */
export function effectiveCostCents(event: CostEventLike): number {
  const billed = event.costCents ?? 0;
  if (billed > 0) return billed;
  return imputeCostCents(event);
}
