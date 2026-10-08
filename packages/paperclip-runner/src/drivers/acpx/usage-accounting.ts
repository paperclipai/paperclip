import type { CanonicalProviderEvent } from "../../provider-events.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Normalize only semantics established by the pinned, qualified ACP servers. */
export function qualifiedAcpxUsageBreakdown(
  agent: QualifiedAcpxAgent | null,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value;
  const breakdown = record(value);
  if (agent !== "claude" && agent !== "codex" && agent !== "pi") return breakdown;
  // Claude SDK aggregate output and Codex ACP toPromptUsage.outputTokens both
  // INCLUDE reasoning. The exact pinned Pi OpenRouter model uses
  // openai-completions, where completion_tokens also includes reasoning. PRP folds thought into output, so its additive component
  // is zero here, not the provider's diagnostic reasoning-token subset.
  return {
    ...breakdown,
    thoughtTokens: 0,
    // Codex ACP 1.6.2 has no cache-write billing category. Do not apply this
    // provider-specific zero to Claude/Pi or to an explicitly invalid value.
    ...(agent === "codex" && breakdown.cachedWriteTokens === undefined
      ? { cachedWriteTokens: 0 }
      : {}),
  };
}

/**
 * ACPX persists terminal prompt-response usage but does not stream it. Recover
 * exactly the new prompt receipt belonging to this turn, never a prior receipt
 * or the misleadingly named cumulative_token_usage (which is last-write-wins).
 */
export function persistedAcpxTurnUsage(
  before: unknown,
  after: unknown,
  requestId: string,
  agent: QualifiedAcpxAgent | null = null,
): Record<string, unknown> | null {
  const current = record(after);
  if (current.lastRequestId !== requestId) return null;
  const previousReceipts = record(record(before).requestTokenUsage);
  const receipts = record(current.requestTokenUsage);
  const added = Object.keys(receipts).filter(
    (key) => !Object.hasOwn(previousReceipts, key),
  );
  if (added.length !== 1) return null;
  const usage = record(receipts[added[0]!]);
  const piReceipt = agent === "pi" ? record(usage.paperclip_pi) : {};
  const piReceiptVerified = piReceipt.provenance === "assistant_message_receipts"
    || piReceipt.provenance === "assistant_message_and_compaction_receipts";
  const estimate = piReceiptVerified && typeof piReceipt.cost_usd === "number"
    && Number.isFinite(piReceipt.cost_usd) && piReceipt.cost_usd >= 0 ? piReceipt.cost_usd : undefined;
  const costDelta = agent === "claude" || agent === "grok"
    ? qualifiedPromptCostDelta(record(before), current, previousReceipts)
    : undefined;
  return {
    type: "status",
    tag: "usage_update",
    text: "terminal prompt usage",
    // Pi calculates cost from catalog prices, not billing receipts. Never feed
    // this estimate into the authoritative/cumulative provider spend channel.
    cost: agent === "pi" ? undefined : current.usageCost,
    ...(costDelta === undefined ? {} : { costDelta }),
    ...(piReceiptVerified ? { usageProvenance: `pi_${piReceipt.provenance}` } : {}),
    ...(estimate === undefined ? {} : { pricingEstimateUsd: estimate }),
    breakdown: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedReadTokens: usage.cache_read_input_tokens,
      cachedWriteTokens: usage.cache_creation_input_tokens,
      thoughtTokens: usage.thought_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}

/** A terminal prompt receipt binds this delta to exactly one new prompt. ACPX
 * cost itself is cumulative; never copy that total into per-run accounting. */
function qualifiedPromptCostDelta(before: Record<string, unknown>, after: Record<string, unknown>, priorReceipts: Record<string, unknown>) {
  const units = (value: unknown): number | null => {
    const cost = record(value);
    if (typeof cost.currency !== "string" || cost.currency.toUpperCase() !== "USD"
      || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0) return null;
    const rounded = Math.round(cost.amount * 1_000_000_000);
    return Number.isSafeInteger(rounded) ? rounded : null;
  };
  const current = units(after.usageCost);
  const reportedPrior = units(before.usageCost);
  // Only a genuinely fresh record can establish the initial zero baseline.
  // A prior prompt without a cost receipt makes the cumulative bill unknown.
  const fresh = before.lastRequestId == null && Object.keys(priorReceipts).length === 0
    && (!Array.isArray(before.promptMessageIds) || before.promptMessageIds.length === 0);
  const prior = reportedPrior ?? (fresh ? 0 : null);
  if (current === null || prior === null || current < prior) return undefined;
  return { amount: (current - prior) / 1_000_000_000, currency: "USD" };
}

/** Preserve the estimate for inspection while keeping billing authority separate. */
export function acpxUsageEstimateNotice(usage: Record<string, unknown>, itemId: string): CanonicalProviderEvent | null {
  if ((usage.usageProvenance !== "pi_assistant_message_receipts"
      && usage.usageProvenance !== "pi_assistant_message_and_compaction_receipts")
    || typeof usage.pricingEstimateUsd !== "number" || !Number.isFinite(usage.pricingEstimateUsd)
    || usage.pricingEstimateUsd < 0) return null;
  return {
    eventType: "provider.notice.recorded", itemId,
    payload: {
      schema: "paperclip.provider.notice.v1", noticeId: itemId,
      severity: "info", category: "pi_usage_pricing_estimate", scope: "turn",
      recoverable: true, userActionable: false,
      summary: `Pi estimates this turn at $${usage.pricingEstimateUsd.toFixed(6)} from its model prices. Billing cost is unverified.`,
      details: [{ name: "Cost source", value: "Pi model catalog pricing estimate" },
        { name: "Usage source", value: usage.usageProvenance === "pi_assistant_message_and_compaction_receipts"
          ? "Assistant message and compaction receipts for this prompt" : "Assistant message receipts for this prompt" },
        { name: "Estimated USD", value: String(usage.pricingEstimateUsd) }],
    },
  };
}
