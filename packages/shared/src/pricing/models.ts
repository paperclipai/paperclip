interface ModelPricing {
  inputCentsPer1k: number;
  outputCentsPer1k: number;
  cachedInputCentsPer1k?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-4o": { inputCentsPer1k: 0.25, outputCentsPer1k: 1.0, cachedInputCentsPer1k: 0.125 },
  "gpt-4o-mini": { inputCentsPer1k: 0.015, outputCentsPer1k: 0.06, cachedInputCentsPer1k: 0.0075 },
  "gpt-4-turbo": { inputCentsPer1k: 1.0, outputCentsPer1k: 3.0 },
  "gpt-4": { inputCentsPer1k: 3.0, outputCentsPer1k: 6.0 },
  "gpt-3.5-turbo": { inputCentsPer1k: 0.05, outputCentsPer1k: 0.15 },
  "claude-sonnet-4-20250514": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5, cachedInputCentsPer1k: 0.03 },
  "claude-opus-4-20250514": { inputCentsPer1k: 1.5, outputCentsPer1k: 7.5, cachedInputCentsPer1k: 0.15 },
  "claude-3-5-sonnet-20241022": { inputCentsPer1k: 0.3, outputCentsPer1k: 1.5, cachedInputCentsPer1k: 0.03 },
  "claude-3-5-haiku-20241022": { inputCentsPer1k: 0.08, outputCentsPer1k: 0.4, cachedInputCentsPer1k: 0.008 },
  "claude-3-opus-20240229": { inputCentsPer1k: 1.5, outputCentsPer1k: 7.5, cachedInputCentsPer1k: 0.15 },
};

export function calculateTokenCostCents(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens?: number,
): number | null {
  if (!model) return null;
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  const nonCachedInputTokens = Math.max(0, inputTokens - (cachedInputTokens ?? 0));
  const inputCost = (nonCachedInputTokens / 1000) * pricing.inputCentsPer1k;
  const outputCost = (outputTokens / 1000) * pricing.outputCentsPer1k;
  const cachedCost = cachedInputTokens && pricing.cachedInputCentsPer1k
    ? (cachedInputTokens / 1000) * pricing.cachedInputCentsPer1k
    : 0;
  return Math.max(0, Math.round(inputCost + outputCost + cachedCost));
}

export function getModelPricing(model: string): ModelPricing | null {
  return MODEL_PRICING[model] ?? null;
}
