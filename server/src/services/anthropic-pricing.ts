import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

// Direct Anthropic API list prices, verified 2026-10-07:
// https://platform.claude.com/docs/en/about-claude/pricing
// Keep this bounded to the qualified model; aliases and other billers stay unknown.
const RATES = ["2", "0.2", "4", "10"] as const;

/** A complete token receipt can receive an explicit estimate, never an invoice
 * claim. ACP aggregates cache writes without TTL; conservatively price them at
 * the documented one-hour rate rather than silently assume five-minute writes. */
export function priceAnthropicReceipt(receipt: AdapterUsageCheckpoint): AdapterUsageCheckpoint {
  if (!receipt.complete || !receipt.usage || receipt.usageBasis !== "per_run"
    || receipt.provider !== "anthropic" || receipt.biller !== "anthropic"
    || !["api", "metered_api"].includes(receipt.billingType ?? "")
    || receipt.model !== "claude-sonnet-5" || receipt.usageByModel?.length
    || receipt.costUsd != null || receipt.costUsdExact != null || receipt.cacheAdjustedCostUsd != null
    || (receipt.pricingContext?.serviceTier && !["standard", "default"].includes(receipt.pricingContext.serviceTier))) return receipt;
  const usage = receipt.usage;
  if (usage.cacheWriteTokens === undefined || usage.cachedInputTokens === undefined) return receipt;
  const counts = [usage.inputTokens - usage.cacheWriteTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return receipt;
  const numerator = counts.reduce((total, count, index) => total + BigInt(count) * usdToUnits(RATES[index]), 0n);
  return { ...receipt, costUsdExact: centsToUsd(unitsToCents((numerator + 500_000n) / 1_000_000n)), costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card", version: "anthropic-standard-2026-10-07",
      evidence: "https://platform.claude.com/docs/en/about-claude/pricing; standard global API pricing assumed; cache-write TTL unavailable, one-hour upper rate used; not an invoice",
      inputCentsPerMillion: "200", cachedInputCentsPerMillion: "20", cacheWriteCentsPerMillion: "400", outputCentsPerMillion: "1000", serviceTier: "standard",
    },
  };
}
