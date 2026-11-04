import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

const RATE_CARDS: Record<string, { rates: readonly string[]; version: string }> = {
  "claude-sonnet-5": { rates: ["2", "0.2", "4", "10"], version: "anthropic-standard-2026-10-07" },
  "claude-opus-5-5": { rates: ["4", "0.2", "8", "20"], version: "anthropic-standard-2026-10-12" },
};

/** A complete token receipt can receive an explicit estimate, never an invoice
 * claim. ACP aggregates cache writes without TTL; conservatively price them at
 * the documented one-hour rate rather than silently assume five-minute writes. */
export function priceAnthropicReceipt(receipt: AdapterUsageCheckpoint): AdapterUsageCheckpoint {
  const card = receipt.model && Object.hasOwn(RATE_CARDS, receipt.model) ? RATE_CARDS[receipt.model] : undefined;
  if (!receipt.complete || !receipt.usage || receipt.usageBasis !== "per_run"
    || receipt.provider !== "anthropic" || receipt.biller !== "anthropic"
    || !["api", "metered_api"].includes(receipt.billingType ?? "")
    || !card || receipt.usageByModel?.length
    || receipt.costUsd != null || receipt.costUsdExact != null || receipt.cacheAdjustedCostUsd != null
    || (receipt.pricingContext?.serviceTier && !["standard", "default"].includes(receipt.pricingContext.serviceTier))) return receipt;
  const usage = receipt.usage;
  if (usage.cacheWriteTokens === undefined || usage.cachedInputTokens === undefined) return receipt;
  const counts = [usage.inputTokens - usage.cacheWriteTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return receipt;
  const numerator = counts.reduce((total, count, index) => total + BigInt(count) * usdToUnits(card.rates[index]), 0n);
  return { ...receipt, costUsdExact: centsToUsd(unitsToCents((numerator + 500_000n) / 1_000_000n)), costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card", version: card.version,
      evidence: "https://platform.claude.com/docs/en/about-claude/pricing; standard global API pricing assumed; cache-write TTL unavailable, one-hour upper rate used; not an invoice",
      inputCentsPerMillion: (usdToUnits(card.rates[0]) / 10_000_000n).toString(),
      cachedInputCentsPerMillion: (usdToUnits(card.rates[1]) / 10_000_000n).toString(),
      cacheWriteCentsPerMillion: (usdToUnits(card.rates[2]) / 10_000_000n).toString(),
      outputCentsPerMillion: (usdToUnits(card.rates[3]) / 10_000_000n).toString(), serviceTier: "standard",
    },
  };
}
