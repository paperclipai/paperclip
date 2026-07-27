export interface ModelCostInput {
  costUsd?: number | null;
  costCents?: number | null;
  billingType?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
}

interface ModelRates {
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedTokensIncludedInInput?: boolean;
}

const MODEL_RATES: Array<{ match: RegExp; rates: ModelRates }> = [
  {
    match: /claude-opus-5-fast/i,
    rates: {
      inputMicrosPerMillion: 10_000_000,
      cachedInputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 50_000_000,
    },
  },
  {
    match: /claude-opus-(4|5)/i,
    rates: {
      inputMicrosPerMillion: 5_000_000,
      cachedInputMicrosPerMillion: 500_000,
      outputMicrosPerMillion: 25_000_000,
    },
  },
  {
    match: /claude-sonnet-(4|5)/i,
    rates: {
      inputMicrosPerMillion: 3_000_000,
      cachedInputMicrosPerMillion: 300_000,
      outputMicrosPerMillion: 15_000_000,
    },
  },
  {
    match: /claude-haiku-4/i,
    rates: {
      inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 100_000,
      outputMicrosPerMillion: 5_000_000,
    },
  },
  // gpt-5.6 is tiered per variant (luna < terra < sol); each -pro variant prices the
  // same as its base. Most specific first -- MODEL_RATES takes the first match.
  // Cached tokens arrive as a separate count from clawrouter/pi (observed:
  // input 10_304 vs cached 76_453 on the same event), so they are not netted
  // out of inputTokens the way the direct-OpenAI gpt-5.5 entry assumes.
  {
    match: /gpt-5\.6-luna/i,
    rates: {
      inputMicrosPerMillion: 1_000_000,
      cachedInputMicrosPerMillion: 100_000,
      outputMicrosPerMillion: 6_000_000,
    },
  },
  {
    match: /gpt-5\.6-terra/i,
    rates: {
      inputMicrosPerMillion: 2_500_000,
      cachedInputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 15_000_000,
    },
  },
  {
    // sol, and the fallback for any unrecognised gpt-5.6 variant: price at the top
    // of the family rather than under-reporting spend.
    match: /gpt-5\.6/i,
    rates: {
      inputMicrosPerMillion: 5_000_000,
      cachedInputMicrosPerMillion: 500_000,
      outputMicrosPerMillion: 30_000_000,
    },
  },
  {
    match: /gpt-5\.5/i,
    rates: {
      inputMicrosPerMillion: 5_000_000,
      cachedInputMicrosPerMillion: 500_000,
      outputMicrosPerMillion: 30_000_000,
      cachedTokensIncludedInInput: true,
    },
  },
  {
    match: /gpt-5\.4(?!-mini)/i,
    rates: {
      inputMicrosPerMillion: 2_500_000,
      cachedInputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 15_000_000,
      cachedTokensIncludedInInput: true,
    },
  },
  {
    match: /gpt-4\.1-mini|gpt-5\.4-mini/i,
    rates: {
      inputMicrosPerMillion: 400_000,
      cachedInputMicrosPerMillion: 100_000,
      outputMicrosPerMillion: 1_600_000,
      cachedTokensIncludedInInput: true,
    },
  },
];

const ESTIMATED_BILLING_TYPES = new Set(["subscription_included", "subscription_overage"]);

export function normalizeModelCostCents(costUsd: number | null | undefined): number {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

export function resolveCostEventCostCents(input: ModelCostInput): number {
  const reportedCost = normalizeCostCents(input.costCents);
  if (reportedCost > 0) return reportedCost;
  return estimateKnownModelCostCents(input);
}

export function resolveModelCostCents(input: ModelCostInput): number {
  const reportedCost = normalizeModelCostCents(input.costUsd);
  if (reportedCost > 0) return reportedCost;
  return estimateKnownModelCostCents(input);
}

function estimateKnownModelCostCents(input: ModelCostInput): number {
  if (!input.billingType || !ESTIMATED_BILLING_TYPES.has(input.billingType)) return 0;

  const key = [input.provider, input.model].filter(Boolean).join("/");
  const match = MODEL_RATES.find((entry) => entry.match.test(key));
  if (!match) return 0;

  const cachedInputTokens = nonNegative(input.cachedInputTokens);
  const inputTokens = match.rates.cachedTokensIncludedInInput
    ? Math.max(0, nonNegative(input.inputTokens) - cachedInputTokens)
    : nonNegative(input.inputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const microDollars =
    tokenMicros(inputTokens, match.rates.inputMicrosPerMillion) +
    tokenMicros(cachedInputTokens, match.rates.cachedInputMicrosPerMillion) +
    tokenMicros(outputTokens, match.rates.outputMicrosPerMillion);
  return Math.max(0, Math.round(microDollars / 10_000));
}

function normalizeCostCents(costCents: number | null | undefined): number {
  if (typeof costCents !== "number" || !Number.isFinite(costCents)) return 0;
  return Math.max(0, Math.round(costCents));
}

function tokenMicros(tokens: number, microsPerMillion: number): number {
  return (tokens * microsPerMillion) / 1_000_000;
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
