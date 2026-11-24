import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { MODEL_LIST_PRICES } from "./model-list-prices.js";

// Immutable, reviewed rate card. Existing receipts retain their selected rates.
// https://developers.openai.com/api/docs/pricing (retrieved 2026-09-30)
const VERSION = "openai-standard-2026-09-30";
const RATES: Record<string, readonly [string, string, string, string]> = Object.fromEntries(
  ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"].map((model) => [model, MODEL_LIST_PRICES[model]]),
);

/** Price new, direct-API receipts only. A token-price estimate is not an invoice.
 * Run totals cannot establish per-request context length or cache-write splits;
 * preserve those assumptions instead of inferring a long request from a long run. */
export function priceCodexReceipt(
  receipt: AdapterUsageCheckpoint,
): AdapterUsageCheckpoint {
  if (
    !receipt.complete ||
    receipt.costUsd != null ||
    receipt.costUsdExact != null ||
    receipt.cacheAdjustedCostUsd != null ||
    receipt.provider !== "openai" ||
    receipt.biller !== "openai" ||
    !["api", "metered_api"].includes(receipt.billingType ?? "") ||
    receipt.usageBasis !== "per_run" ||
    !receipt.usage ||
    receipt.usageByModel?.length
  )
    return receipt;
  const model = receipt.model ?? "";
  const rates = Object.hasOwn(RATES, model) ? RATES[model] : undefined;
  if (!rates) return receipt;
  const usage = receipt.usage;
  const counts = [
    usage.inputTokens - (usage.cacheWriteTokens ?? 0),
    usage.cachedInputTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.outputTokens,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return receipt;
  const context = receipt.pricingContext;
  if (
    context?.serviceTier &&
    !["standard", "default", "priority", "fast", "flex", "batch"].includes(
      context.serviceTier,
    )
  )
    return receipt;
  const tierNumerator =
    context?.serviceTier === "priority" || context?.serviceTier === "fast"
      ? 2n
      : 1n;
  const tierDenominator =
    context?.serviceTier === "flex" || context?.serviceTier === "batch"
      ? 2n
      : 1n;
  const units = counts.reduce((total, count, index) => {
    const longNumerator =
      context?.contextTier === "long" ? (index === 3 ? 3n : 4n) : 2n;
    return (
      total +
      BigInt(count) * usdToUnits(rates[index]) * tierNumerator * longNumerator
    );
  }, 0n);
  const divisor = 1_000_000n * tierDenominator * 2n;
  const costCents = unitsToCents((units + divisor / 2n) / divisor);
  const assumptions = [
    !context?.serviceTier
      ? "standard processing assumed"
      : `${context.serviceTier} processing`,
    !context?.contextTier
      ? "short per-request context assumed"
      : `${context.contextTier} per-request context`,
    usage.cacheWriteTokens === undefined
      ? "cache writes not separately reported"
      : "cache writes reported",
  ];
  return {
    ...receipt,
    costUsdExact: centsToUsd(costCents),
    costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card",
      version: VERSION,
      evidence: `https://developers.openai.com/api/docs/pricing; ${assumptions.join("; ")}`
        + (receipt.pricingProvenance?.evidence ? `; ${receipt.pricingProvenance.evidence}` : ""),
      inputCentsPerMillion: unitsToCents(usdToUnits(rates[0])),
      cachedInputCentsPerMillion: unitsToCents(usdToUnits(rates[1])),
      cacheWriteCentsPerMillion: unitsToCents(usdToUnits(rates[2])),
      outputCentsPerMillion: unitsToCents(usdToUnits(rates[3])),
      serviceTier: context?.serviceTier ?? "standard",
      contextTier: context?.contextTier ?? "short",
    },
  };
}
