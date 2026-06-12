/** Per-token price catalog (input tokens, EUR cents per 1M tokens).
 *
 *  Hardcoded snapshot: vendors change pricing rarely, a hardcoded table is
 *  auditable in git, and dashboards import the same constant. Manual update
 *  workflow:
 *    1. Bump CATALOG_VERSION + LAST_UPDATED.
 *    2. Update PRICE_TABLE entries.
 *    3. Re-run tests — fixtures pin expected estimated_cost values, so a price
 *       change must propagate explicitly.
 *
 *  Output-token pricing is intentionally out of scope: the router only sees the
 *  input descriptor, not the response. Callers fill `actual_cost_eur_cents`
 *  with end-to-end totals after the call resolves.
 */

export const CATALOG_VERSION = 'pricing-2026-05-06' as const;
export const LAST_UPDATED = '2026-05-06' as const;

/** Input-token price in EUR cents per 1M tokens. EUR conversion baked in to keep
 *  the router stateless — refresh whenever vendor USD price or FX moves materially. */
const PRICE_TABLE: Record<string, number> = {
  // Claude family
  'claude-haiku-4-5': 80, // ~$0.80/1M
  'claude-sonnet-4-6': 280, // ~$3.00/1M
  'claude-opus-4-7': 1400, // ~$15.00/1M

  // ChatGPT family
  'gpt-4o-mini': 14, // ~$0.15/1M
  'gpt-4o': 230, // ~$2.50/1M
  'gpt-5': 1100, // ~$12.00/1M

  // Gemini family — long-context premium kicks in over 128k
  'gemini-flash': 7, // ~$0.075/1M
  'gemini-pro': 110, // ~$1.25/1M
  'gemini-ultra-long-context': 600, // ~$6.50/1M

  // Perplexity family
  'perplexity-sonar': 90, // bundled in Pro subscription, conservative cents/1M
  'perplexity-sonar-pro': 280,

  // API placeholder — replaced by adapter at call site
  'api-automation-default': 230,
};

/** EUR cents for the planned input pass. Returns 0 if the model is unknown
 *  (router still routes; cost is best-effort). */
export function estimateInputCost(model: string, estimatedInputTokens?: number): number {
  if (!estimatedInputTokens || estimatedInputTokens <= 0) return 0;
  const pricePerMillion = PRICE_TABLE[model];
  if (pricePerMillion === undefined) return 0;
  // Round to nearest cent; never return fractional cents downstream.
  return Math.round((estimatedInputTokens / 1_000_000) * pricePerMillion);
}

/** Exposed for tests / dashboard import. */
export function pricePerMillion(model: string): number | undefined {
  return PRICE_TABLE[model];
}
