export const MODEL_PRICING_VERSION = "provider-list-prices-2026-09-05" as const;

interface TokenRatesUsdPerMillion {
  input: number;
  cachedInput: number;
  output: number;
}

// Versioned OpenAI API list prices, not the customer's actual invoice or Codex-plan debit.
// Source: https://developers.openai.com/api/docs/models
const RATES: Readonly<Record<string, TokenRatesUsdPerMillion>> = Object.freeze({
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  // Qualified Anthropic direct profile. Actual invoice discounts are intentionally excluded.
  "claude-sonnet-5": { input: 3, cachedInput: 0.3, output: 15 },
  // Amazon Bedrock global cross-region list price for Claude Sonnet 4.6.
  "global.anthropic.claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
  // OpenRouter list-price snapshot used by the qualified OpenCode breadth lane.
  "openrouter/anthropic/claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 },
  "openrouter/qwen/qwen3.8-max-0902": { input: 2, cachedInput: 0.25, output: 6 },
  "openrouter/google/gemini-3.8-flash": { input: 0.75, cachedInput: 0.075, output: 3.75 },
  "openrouter/z-ai/glm-5.3": { input: 1.4, cachedInput: 0.14, output: 4.4 },
  "openrouter/deepseek/deepseek-v4-flash-0731": { input: 0.065, cachedInput: 0.016, output: 0.18 },
  "openrouter/openai/gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
});

export interface EstimatedModelCost {
  estimatedCostNanodollars: number;
  pricingVersion: typeof MODEL_PRICING_VERSION;
  ratesUsdPerMillionTokens: TokenRatesUsdPerMillion;
}

export function estimateModelCostNanodollars(
  model: string,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
): EstimatedModelCost {
  const rates = RATES[model];
  if (rates === undefined) throw new Error(`model pricing unavailable for ${model}`);
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const estimatedCostNanodollars = Math.round(
    uncachedInput * rates.input * 1_000
      + usage.cachedInputTokens * rates.cachedInput * 1_000
      + usage.outputTokens * rates.output * 1_000,
  );
  return { estimatedCostNanodollars, pricingVersion: MODEL_PRICING_VERSION, ratesUsdPerMillionTokens: { ...rates } };
}
