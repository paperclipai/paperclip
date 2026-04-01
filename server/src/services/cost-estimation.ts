import type { BillingType } from "@paperclipai/shared";

export interface CostUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface BilledCostResolution {
  costUsd: number | null;
  costCents: number;
  estimated: boolean;
  source: "provider_reported" | "openai_model_pricing" | "unknown";
}

type ModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  longContextThresholdPromptTokens?: number;
  longContextInputMultiplier?: number;
  longContextCachedInputMultiplier?: number;
  longContextOutputMultiplier?: number;
};

const TOKENS_PER_MILLION = 1_000_000;

const OPENAI_MODEL_PRICING: Array<{ match: (model: string) => boolean; pricing: ModelPricing }> = [
  {
    match: (model) => model === "gpt-5.4" || model.startsWith("gpt-5.4-"),
    pricing: {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
      longContextThresholdPromptTokens: 272_000,
      longContextInputMultiplier: 2,
      // OpenAI documents the long-context uplift for input/output on GPT-5.4.
      // We apply the same input uplift to cached input because cached prompt
      // tokens still consume the long-context window and are billed as discounted input.
      longContextCachedInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
    },
  },
];

function normalizeKnownParty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function roundUsdToCents(costUsd: number | null | undefined): number {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

function resolveOpenAiPricing(model: string | null | undefined): ModelPricing | null {
  const normalizedModel = normalizeModel(model);
  if (!normalizedModel) return null;
  for (const entry of OPENAI_MODEL_PRICING) {
    if (entry.match(normalizedModel)) return entry.pricing;
  }
  return null;
}

function resolveLongContextShare(input: {
  usage: CostUsageTotals;
  rawUsage: CostUsageTotals | null | undefined;
  previousRawUsage: CostUsageTotals | null | undefined;
  pricing: ModelPricing;
}): number {
  const threshold = input.pricing.longContextThresholdPromptTokens ?? 0;
  if (threshold <= 0) return 0;

  const deltaPromptTokens = Math.max(0, input.usage.inputTokens + input.usage.cachedInputTokens);
  if (deltaPromptTokens <= 0) return 0;

  const currentPromptTokens = Math.max(
    0,
    (input.rawUsage?.inputTokens ?? input.usage.inputTokens) +
      (input.rawUsage?.cachedInputTokens ?? input.usage.cachedInputTokens),
  );
  const previousPromptTokens =
    input.previousRawUsage
      ? Math.max(0, input.previousRawUsage.inputTokens + input.previousRawUsage.cachedInputTokens)
      : Math.max(0, currentPromptTokens - deltaPromptTokens);

  if (previousPromptTokens >= threshold) return 1;
  if (currentPromptTokens <= threshold) return 0;

  return Math.max(0, Math.min(1, (currentPromptTokens - threshold) / deltaPromptTokens));
}

export function estimateMeteredCostUsd(input: {
  provider: string | null | undefined;
  biller: string | null | undefined;
  model: string | null | undefined;
  billingType: BillingType;
  usage: CostUsageTotals | null | undefined;
  rawUsage?: CostUsageTotals | null | undefined;
  previousRawUsage?: CostUsageTotals | null | undefined;
}): number | null {
  if (input.billingType !== "metered_api" || !input.usage) return null;

  const provider = normalizeKnownParty(input.provider);
  const biller = normalizeKnownParty(input.biller);
  if (provider !== "openai" && biller !== "openai") return null;

  const pricing = resolveOpenAiPricing(input.model);
  if (!pricing) return null;

  const longContextShare = resolveLongContextShare({
    usage: input.usage,
    rawUsage: input.rawUsage,
    previousRawUsage: input.previousRawUsage,
    pricing,
  });
  const standardShare = 1 - longContextShare;
  const inputMultiplier = standardShare + longContextShare * (pricing.longContextInputMultiplier ?? 1);
  const cachedInputMultiplier =
    standardShare + longContextShare * (pricing.longContextCachedInputMultiplier ?? pricing.longContextInputMultiplier ?? 1);
  const outputMultiplier = standardShare + longContextShare * (pricing.longContextOutputMultiplier ?? 1);

  const inputCostUsd =
    (input.usage.inputTokens / TOKENS_PER_MILLION) *
    pricing.inputUsdPerMillion *
    inputMultiplier;
  const cachedInputCostUsd =
    (input.usage.cachedInputTokens / TOKENS_PER_MILLION) *
    pricing.cachedInputUsdPerMillion *
    cachedInputMultiplier;
  const outputCostUsd =
    (input.usage.outputTokens / TOKENS_PER_MILLION) *
    pricing.outputUsdPerMillion *
    outputMultiplier;

  const total = inputCostUsd + cachedInputCostUsd + outputCostUsd;
  return Number.isFinite(total) ? total : null;
}

export function resolveBilledCost(input: {
  providerCostUsd: number | null | undefined;
  provider: string | null | undefined;
  biller: string | null | undefined;
  model: string | null | undefined;
  billingType: BillingType;
  usage: CostUsageTotals | null | undefined;
  rawUsage?: CostUsageTotals | null | undefined;
  previousRawUsage?: CostUsageTotals | null | undefined;
}): BilledCostResolution {
  if (input.billingType === "subscription_included") {
    return {
      costUsd: 0,
      costCents: 0,
      estimated: false,
      source: "provider_reported",
    };
  }

  if (typeof input.providerCostUsd === "number" && Number.isFinite(input.providerCostUsd)) {
    return {
      costUsd: input.providerCostUsd,
      costCents: roundUsdToCents(input.providerCostUsd),
      estimated: false,
      source: "provider_reported",
    };
  }

  const estimatedUsd = estimateMeteredCostUsd({
    provider: input.provider,
    biller: input.biller,
    model: input.model,
    billingType: input.billingType,
    usage: input.usage,
    rawUsage: input.rawUsage,
    previousRawUsage: input.previousRawUsage,
  });
  if (estimatedUsd !== null) {
    return {
      costUsd: estimatedUsd,
      costCents: roundUsdToCents(estimatedUsd),
      estimated: true,
      source: "openai_model_pricing",
    };
  }

  return {
    costUsd: null,
    costCents: 0,
    estimated: false,
    source: "unknown",
  };
}
