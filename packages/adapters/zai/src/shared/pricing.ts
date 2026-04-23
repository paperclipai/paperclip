export interface ZaiModelPricing {
  /** USD per 1 million non-cached input tokens. */
  inputPer1M: number;
  /** USD per 1 million output tokens. */
  outputPer1M: number;
  /** USD per 1 million cached input tokens (usually much cheaper than input). */
  cachedInputPer1M: number;
}

/**
 * Z.AI General API (pay-as-you-go) reference prices, per million tokens, USD.
 *
 * These are used to compute `costUsd` for management/gestão reporting
 * regardless of which endpoint actually billed the request:
 *
 *   - On the pay-as-you-go endpoint (api/paas/v4) this is the actual charge.
 *   - On the Coding Plan endpoint (api/coding/paas/v4) the request is billed
 *     against the flat subscription quota, so there is no per-token cost —
 *     but management reports still want a $ number to attribute to runs,
 *     compare across models, and reason about if/when to switch plans.
 *     Using the public pay-as-you-go table as that reference keeps cost
 *     tracking consistent across plans.
 *
 * Source: https://docs.z.ai/guides/overview/pricing  (captured 2026-04)
 *
 * Update these numbers whenever Z.AI republishes pricing. Missing or
 * unknown model ids get null from computeZaiCostUsd(), which the adapter
 * treats as "cost unknown for this model" — safer than guessing.
 */
export const ZAI_MODEL_PRICING: Record<string, ZaiModelPricing> = {
  "glm-5.1":             { inputPer1M: 1.4,  outputPer1M: 4.4, cachedInputPer1M: 0.26 },
  "glm-5":               { inputPer1M: 1.0,  outputPer1M: 3.2, cachedInputPer1M: 0.2 },
  "glm-5-turbo":         { inputPer1M: 1.2,  outputPer1M: 4.0, cachedInputPer1M: 0.24 },
  "glm-4.7":             { inputPer1M: 0.6,  outputPer1M: 2.2, cachedInputPer1M: 0.11 },
  "glm-4.7-flashx":      { inputPer1M: 0.07, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
  "glm-4.7-flash":       { inputPer1M: 0,    outputPer1M: 0,   cachedInputPer1M: 0 },
  "glm-4.6":             { inputPer1M: 0.6,  outputPer1M: 2.2, cachedInputPer1M: 0.11 },
  "glm-4.5":             { inputPer1M: 0.6,  outputPer1M: 2.2, cachedInputPer1M: 0.11 },
  "glm-4.5-x":           { inputPer1M: 2.2,  outputPer1M: 8.9, cachedInputPer1M: 0.45 },
  "glm-4.5-air":         { inputPer1M: 0.2,  outputPer1M: 1.1, cachedInputPer1M: 0.03 },
  "glm-4.5-airx":        { inputPer1M: 1.1,  outputPer1M: 4.5, cachedInputPer1M: 0.22 },
  "glm-4.5-flash":       { inputPer1M: 0,    outputPer1M: 0,   cachedInputPer1M: 0 },
  "glm-4-32b-0414-128k": { inputPer1M: 0.1,  outputPer1M: 0.1, cachedInputPer1M: 0 },
};

/**
 * Compute USD cost for a Z.AI call given model id and token usage.
 *
 * Returns null when the model id isn't in the pricing table — the caller
 * should skip the cost field rather than fabricate a number.
 *
 * `inputTokens` is the total prompt tokens (cached + non-cached), matching
 * Z.AI's OpenAI-compatible `usage.prompt_tokens` field. `cachedInputTokens`
 * is the cache-hit portion. Non-cached input is billed at the full input
 * rate, cached input at the cached rate.
 */
export function computeZaiCostUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
): number | null {
  const normalized = modelId.trim().toLowerCase();
  const pricing = ZAI_MODEL_PRICING[normalized];
  if (!pricing) return null;

  const cachedInput = Math.max(0, usage.cachedInputTokens ?? 0);
  const nonCachedInput = Math.max(0, (usage.inputTokens ?? 0) - cachedInput);
  const output = Math.max(0, usage.outputTokens ?? 0);

  const cost =
    (nonCachedInput * pricing.inputPer1M) / 1_000_000 +
    (cachedInput * pricing.cachedInputPer1M) / 1_000_000 +
    (output * pricing.outputPer1M) / 1_000_000;

  // Round to 6 decimals (micro-dollars). Enough precision for short runs
  // and avoids JS float noise in the reported number.
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Whether a base URL points at the Coding Plan endpoint (subscription-billed)
 * rather than the general pay-as-you-go endpoint. Used to tag runs with the
 * right `billingType` for Paperclip's cost attribution even though our
 * computed `costUsd` always reflects the pay-as-you-go reference rate.
 */
export function isCodingPlanEndpoint(baseUrl: string): boolean {
  return /\/api\/coding\//i.test(baseUrl);
}
