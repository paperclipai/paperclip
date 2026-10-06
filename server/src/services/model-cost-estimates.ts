import { sql } from "drizzle-orm";
import { costEvents } from "@paperclipai/db";

// Versioned OpenAI API list prices. These are estimates only; provider-reported
// charges remain authoritative and continue to drive budgets.
const MODEL_RATES_USD_PER_MILLION = {
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
} as const;

export function estimateModelCostCents(input: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const rates = MODEL_RATES_USD_PER_MILLION[
    input.model as keyof typeof MODEL_RATES_USD_PER_MILLION
  ];
  if (!rates) return 0;
  const uncachedInput = Math.max(0, input.inputTokens - input.cachedInputTokens);
  return (
    uncachedInput * rates.input +
    input.cachedInputTokens * rates.cachedInput +
    input.outputTokens * rates.output
  ) / 10_000;
}

export function estimatedMeteredCostCentsSql() {
  const rate = (kind: "input" | "cachedInput" | "output") => sql<number>`case
    when ${costEvents.model} = 'gpt-5.6-sol' then ${MODEL_RATES_USD_PER_MILLION["gpt-5.6-sol"][kind]}::double precision
    when ${costEvents.model} = 'gpt-5.6-terra' then ${MODEL_RATES_USD_PER_MILLION["gpt-5.6-terra"][kind]}::double precision
    when ${costEvents.model} = 'gpt-5.6-luna' then ${MODEL_RATES_USD_PER_MILLION["gpt-5.6-luna"][kind]}::double precision
    else 0::double precision
  end`;

  return sql<number>`coalesce(sum(case
    when ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} = 'metered_api'
      then (
        greatest(${costEvents.inputTokens} - ${costEvents.cachedInputTokens}, 0) * ${rate("input")}
        + ${costEvents.cachedInputTokens} * ${rate("cachedInput")}
        + ${costEvents.outputTokens} * ${rate("output")}
      ) / 10000.0
    else 0
  end), 0)::double precision`;
}

export function visibleCostCentsSql() {
  return sql<number>`(
    coalesce(sum(${costEvents.costCents}), 0)::double precision
    + ${estimatedMeteredCostCentsSql()}
  )`;
}
