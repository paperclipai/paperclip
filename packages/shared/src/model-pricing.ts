/**
 * Model pricing calculator for LLM API costs.
 * 
 * Prices are per 1M tokens in USD cents (multiply by 100).
 * Update this table when provider pricing changes or new models are added.
 * 
 * **OPERATIONAL NOTE:**
 * This table uses exact model version strings (e.g. "gpt-4o-2024-11-20").
 * When providers release new model variants, sessions using unknown models are
 * created successfully but silently record costCents: 0 on every turn, causing
 * budget tracking to fail. Operators should monitor for zero-cost sessions and
 * update this file promptly. Consider adding a PRICING_OVERRIDE env-var or
 * DB-backed override mechanism to allow operators to unblock themselves without
 * a redeploy.
 * 
 * Sources:
 * - OpenAI: https://openai.com/api/pricing/
 * - Anthropic: https://www.anthropic.com/pricing
 */

export interface ModelPricing {
  /** Cost per 1M input tokens in USD cents */
  input: number;
  /** Cost per 1M output tokens in USD cents */
  output: number;
  /** Optional: cost per 1M cached input tokens in USD cents */
  cachedInput?: number;
}

const OPENAI_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { input: 250, output: 1000 },
  "gpt-4o-2024-11-20": { input: 250, output: 1000 },
  "gpt-4o-2024-08-06": { input: 250, output: 1000 },
  "gpt-4o-2024-05-13": { input: 500, output: 1500 },
  "gpt-4o-mini": { input: 15, output: 60 },
  "gpt-4o-mini-2024-07-18": { input: 15, output: 60 },
  "gpt-4-turbo": { input: 1000, output: 3000 },
  "gpt-4-turbo-2024-04-09": { input: 1000, output: 3000 },
  "gpt-4": { input: 3000, output: 6000 },
  "gpt-4-32k": { input: 6000, output: 12000 },
  "gpt-3.5-turbo": { input: 50, output: 150 },
  "gpt-3.5-turbo-0125": { input: 50, output: 150 },
  "o1-preview": { input: 1500, output: 6000 },
  "o1-mini": { input: 300, output: 1200 },
};

const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  "claude-3-5-sonnet-20241022": { input: 300, output: 1500, cachedInput: 30 },
  "claude-3-5-sonnet-20240620": { input: 300, output: 1500, cachedInput: 30 },
  "claude-3-5-haiku-20241022": { input: 100, output: 500, cachedInput: 10 },
  "claude-3-opus-20240229": { input: 1500, output: 7500, cachedInput: 150 },
  "claude-3-sonnet-20240229": { input: 300, output: 1500, cachedInput: 30 },
  "claude-3-haiku-20240307": { input: 25, output: 125, cachedInput: 3 },
};

const ALL_PRICING: Record<string, ModelPricing> = {
  ...OPENAI_PRICING,
  ...ANTHROPIC_PRICING,
};

/**
 * Calculate cost in USD cents for a given model and token usage.
 * Returns 0 for unknown models (logs warning in production).
 */
export function calculateModelCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens?: number,
): number {
  // Normalize model name to lowercase for case-insensitive lookup
  const normalizedModel = model.toLowerCase();
  const pricing = ALL_PRICING[normalizedModel];

  if (!pricing) {
    // Unknown model - return 0 to avoid breaking the flow
    // The caller should log this appropriately
    return 0;
  }

  // Calculate: (tokens / 1M) * price_per_1M_cents
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cachedCost = cachedInputTokens && pricing.cachedInput
    ? (cachedInputTokens / 1_000_000) * pricing.cachedInput
    : 0;

  // Round to nearest cent
  return Math.round(inputCost + outputCost + cachedCost);
}

/**
 * Check if pricing is available for a given model.
 */
export function hasModelPricing(model: string): boolean {
  return model.toLowerCase() in ALL_PRICING;
}

/**
 * Get the pricing table for a specific model (for debugging/display).
 */
export function getModelPricing(model: string): ModelPricing | null {
  return ALL_PRICING[model.toLowerCase()] ?? null;
}
