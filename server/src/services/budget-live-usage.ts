import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceAnthropicReceipt } from "./anthropic-pricing.js";
import { knownRunCostCents } from "./budget-exposure.js";
import { priceCodexReceipt } from "./codex-pricing.js";
import { addCents, compareCents, normalizeCents } from "@paperclipai/shared";

/** Live admission can use a reviewed rate-card estimate before a receipt is
 * final. The original receipt stays incomplete/unpriced for ledger settlement. */
export function liveRunUsageCostCents(receipt: AdapterUsageCheckpoint): string | null {
  const reported = knownRunCostCents({ ...receipt, usageSource: receipt.usageBasis });
  if (reported !== null) return reported;
  if (receipt.usageBasis !== "per_run") return null;
  const projection = priceAnthropicReceipt(priceCodexReceipt({ ...receipt, complete: true }));
  return knownRunCostCents({ ...projection, usageSource: projection.usageBasis });
}

/** Attempt receipts can omit a later price without retracting earlier spend.
 * Keep that knowledge per attempt before combining different models/billers. */
export function createLiveRunUsageProjection(initial?: {
  receipt: AdapterUsageCheckpoint;
  costCents?: string | null;
}) {
  const costs = new Map<string, string>();
  if (initial) {
    const cost = initial.costCents !== undefined ? initial.costCents : liveRunUsageCostCents(initial.receipt);
    if (cost !== null) costs.set("default", normalizeCents(cost));
  }
  return (attemptId: string, receipt: AdapterUsageCheckpoint): string | null => {
    const reported = liveRunUsageCostCents(receipt);
    const previous = costs.get(attemptId);
    if (reported !== null && (receipt.complete || previous === undefined || compareCents(reported, previous) > 0)) {
      costs.set(attemptId, normalizeCents(reported));
    }
    return costs.size ? addCents(...costs.values()) : null;
  };
}
