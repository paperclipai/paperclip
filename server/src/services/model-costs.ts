export interface ModelCostInput {
  costUsd?: number | null;
  costCents?: number | null;
  billingType?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  outputTokens?: number | null;
  /**
   * Whether `inputTokens` already contains `cachedInputTokens`.
   *
   * This is a property of the SOURCE, not the model: gpt-5.5 billed straight
   * from OpenAI bundles cached reads into prompt tokens, while the same model
   * through the OpenClaw gateway reports them separately (upstream computes
   * `input + cacheRead + cacheWrite`). An adapter that knows its own shape
   * should say so; the per-model default is only a guess for callers that do not.
   *
   * True means the reported input total is inclusive of both cache buckets
   * (reads and writes), matching that `input + cacheRead + cacheWrite` sum.
   */
  cachedTokensIncludedInInput?: boolean;
}

interface ModelRates {
  inputMicrosPerMillion: number;
  cachedInputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedTokensIncludedInInput?: boolean;
  /**
   * Cache writes priced as a multiple of the input rate. Anthropic charges
   * 1.25x; the OpenAI-lane models bill nothing for a cache write, so they set 0.
   * Kept as a multiplier rather than an absolute rate so it cannot drift out of
   * step with the input rate it derives from.
   */
  cacheWriteMultiplier?: number;
}

/** Anthropic's published cache-write premium, and the sane default elsewhere. */
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

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
      cacheWriteMultiplier: 0,
    },
  },
  {
    match: /gpt-5\.6-terra/i,
    rates: {
      inputMicrosPerMillion: 2_500_000,
      cachedInputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 15_000_000,
      cacheWriteMultiplier: 0,
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
      cacheWriteMultiplier: 0,
    },
  },
  {
    match: /gpt-5\.5/i,
    rates: {
      inputMicrosPerMillion: 5_000_000,
      cachedInputMicrosPerMillion: 500_000,
      outputMicrosPerMillion: 30_000_000,
      cacheWriteMultiplier: 0,
      cachedTokensIncludedInInput: true,
    },
  },
  {
    match: /gpt-5\.4(?!-mini)/i,
    rates: {
      inputMicrosPerMillion: 2_500_000,
      cachedInputMicrosPerMillion: 250_000,
      outputMicrosPerMillion: 15_000_000,
      cacheWriteMultiplier: 0,
      cachedTokensIncludedInInput: true,
    },
  },
  {
    match: /gpt-4\.1-mini|gpt-5\.4-mini/i,
    rates: {
      inputMicrosPerMillion: 400_000,
      cachedInputMicrosPerMillion: 100_000,
      outputMicrosPerMillion: 1_600_000,
      cacheWriteMultiplier: 0,
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
  const cacheCreationInputTokens = nonNegative(input.cacheCreationInputTokens);
  // The caller knows its own payload shape; the model table is only the default.
  const cachedIncludedInInput =
    input.cachedTokensIncludedInInput ?? match.rates.cachedTokensIncludedInInput ?? false;
  // When the source folds cache tokens into its input total it folds in *both*
  // buckets, so both come back out before input is priced. Subtracting only the
  // reads would bill a cache write twice: once at the input rate, then again at
  // the cache-write multiplier below.
  const inputTokens = cachedIncludedInInput
    ? Math.max(0, nonNegative(input.inputTokens) - cachedInputTokens - cacheCreationInputTokens)
    : nonNegative(input.inputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const cacheWriteMicrosPerMillion =
    match.rates.inputMicrosPerMillion *
    (match.rates.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER);
  const microDollars =
    tokenMicros(inputTokens, match.rates.inputMicrosPerMillion) +
    tokenMicros(cachedInputTokens, match.rates.cachedInputMicrosPerMillion) +
    tokenMicros(cacheCreationInputTokens, cacheWriteMicrosPerMillion) +
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
