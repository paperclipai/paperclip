import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

// Direct Anthropic API list prices, verified 2026-10-09:
// https://platform.claude.com/docs/en/about-claude/pricing
// Exact selected models only; other billers and unreviewed aliases stay unknown.
const RATE_CARDS: Record<string, readonly [string, string, string, string]> = {
  "claude-sonnet-5": ["2", "0.2", "4", "10"],
  "claude-sonnet-4-6": ["3", "0.3", "6", "15"],
  "claude-haiku-4-5-20251001": ["1", "0.1", "2", "5"],
};

/** A complete token receipt can receive an explicit estimate, never an invoice
 * claim. ACP aggregates cache writes without TTL; conservatively price them at
 * the documented one-hour rate rather than silently assume five-minute writes. */
export function priceAnthropicReceipt(receipt: AdapterUsageCheckpoint): AdapterUsageCheckpoint {
  if (!receipt.complete || !receipt.usage || receipt.usageBasis !== "per_run"
    || receipt.provider !== "anthropic" || receipt.biller !== "anthropic"
    || !["api", "metered_api"].includes(receipt.billingType ?? "")
    || !Object.hasOwn(RATE_CARDS, receipt.model ?? "") || receipt.usageByModel?.length
    || receipt.costUsd != null || receipt.costUsdExact != null || receipt.cacheAdjustedCostUsd != null
    || (receipt.pricingContext?.serviceTier && !["standard", "default"].includes(receipt.pricingContext.serviceTier))) return receipt;
  const usage = receipt.usage;
  const rates = RATE_CARDS[receipt.model!]!;
  if (usage.cacheWriteTokens === undefined || usage.cachedInputTokens === undefined) return receipt;
  const counts = [usage.inputTokens - usage.cacheWriteTokens, usage.cachedInputTokens, usage.cacheWriteTokens, usage.outputTokens];
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return receipt;
  const numerator = counts.reduce((total, count, index) => total + BigInt(count) * usdToUnits(rates[index]), 0n);
  return { ...receipt, costUsdExact: centsToUsd(unitsToCents((numerator + 500_000n) / 1_000_000n)), costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card", version: "anthropic-standard-2026-10-09",
      evidence: "https://platform.claude.com/docs/en/about-claude/pricing; standard global API pricing assumed; cache-write TTL unavailable, one-hour upper rate used; not an invoice",
      inputCentsPerMillion: String(Number(rates[0]) * 100), cachedInputCentsPerMillion: String(Number(rates[1]) * 100),
      cacheWriteCentsPerMillion: String(Number(rates[2]) * 100), outputCentsPerMillion: String(Number(rates[3]) * 100), serviceTier: "standard",
    },
  };
}
