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
  return {
    type: "status",
    tag: "usage_update",
    text: "terminal prompt usage",
    // Pi calculates cost from catalog prices, not billing receipts. Never feed
    // this estimate into the authoritative/cumulative provider spend channel.
    cost: agent === "pi" ? undefined : current.usageCost,
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

type CursorPromptUsage = {
  request_id: string; prompt_message_id: string;
  receipt: {
    schema: "paperclip.cursor.native-usage.v1"; source: "native_turn_ended"; promptId: string;
    completeness: "partial"; reasons: string[]; truncated: boolean;
    limits: { maxObservations: 64; maxInvocations: 64; maxBytes: 16384 };
    observations: Array<{ invocationId: string; role: "parent" | "child"; nativeRun: number; sequence: number; counters: Record<string, number> }>;
  };
};
/** Closed diagnostic receipt. Counter semantics and billing are always unverified. */
export function parseCursorPromptUsage(raw: unknown): CursorPromptUsage | null {
  try {
    const text = JSON.stringify(raw);
    if (!text || Buffer.byteLength(text, "utf8") > 16384) return null;
    const v = JSON.parse(text) as CursorPromptUsage;
    const object = (x: unknown): x is object => x !== null && typeof x === "object" && !Array.isArray(x);
    const exact = (x: object, keys: readonly string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
    const id = (x: unknown) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(x);
    if (!object(v) || !exact(v, ["request_id", "prompt_message_id", "receipt"]) || !id(v.request_id) || !id(v.prompt_message_id)) return null;
    const r = v.receipt;
    if (!object(r) || !exact(r, ["schema", "source", "promptId", "completeness", "reasons", "observations", "limits", "truncated"])) return null;
    if (r.schema !== "paperclip.cursor.native-usage.v1" || r.source !== "native_turn_ended" || r.completeness !== "partial" || typeof r.promptId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.promptId) || typeof r.truncated !== "boolean") return null;
    const reasons = ["native_counter_semantics_unverified", "native_counters_missing", "invalid_native_counter", "multiple_terminal_observations", "native_terminal_not_observed", "observation_limit_reached", "child_run_attribution_unverified"];
    if (!Array.isArray(r.reasons) || r.reasons.length > reasons.length || !r.reasons.includes(reasons[0]!) || new Set(r.reasons).size !== r.reasons.length || !r.reasons.every(x => reasons.includes(x))) return null;
    if (!object(r.limits) || !exact(r.limits, ["maxObservations", "maxInvocations", "maxBytes"]) || r.limits.maxObservations !== 64 || r.limits.maxInvocations !== 64 || r.limits.maxBytes !== 16384 || !Array.isArray(r.observations) || r.observations.length > 64) return null;
    const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
    const invocations = new Map<string, { role: string; nativeRun: number; sequence: number }>();
    for (const o of r.observations) {
      if (!object(o) || !exact(o, ["invocationId", "role", "nativeRun", "sequence", "counters"]) || typeof o.invocationId !== "string" || !/^invocation-([1-9]|[1-5][0-9]|6[0-4])$/.test(o.invocationId) || (o.role !== "parent" && o.role !== "child") || !Number.isSafeInteger(o.nativeRun) || o.nativeRun < 1 || !Number.isSafeInteger(o.sequence) || o.sequence < 1 || !object(o.counters)) return null;
      if (!Object.entries(o.counters).every(([k, n]) => fields.includes(k) && Number.isSafeInteger(n) && n >= 0)) return null;
      const previous = invocations.get(o.invocationId);
      if (previous && (previous.role !== o.role || previous.nativeRun !== o.nativeRun || o.sequence <= previous.sequence)) return null;
      invocations.set(o.invocationId, { role: o.role, nativeRun: o.nativeRun, sequence: o.sequence });
    }
    return v;
  } catch { return null; }
}

/** Partial native observations never enter usage_update, aggregate tokens, or USD. */
export function persistedCursorUsageNotice(before: unknown, after: unknown, requestId: string, agent: QualifiedAcpxAgent | null, itemId: string): CanonicalProviderEvent | null {
  if (agent !== "cursor") return null;
  const current = record(after), prior = record(before);
  if (current.lastRequestId !== requestId || prior.lastRequestId === requestId) return null;
  const receipt = parseCursorPromptUsage(current.cursorPromptUsage);
  if (!receipt || receipt.request_id !== requestId) return null;
  const previous = parseCursorPromptUsage(prior.cursorPromptUsage);
  if (previous && (previous.request_id === receipt.request_id || previous.prompt_message_id === receipt.prompt_message_id || previous.receipt.promptId === receipt.receipt.promptId)) return null;
  // A message must have been created by this turn; replacing metadata on an old message is not fresh evidence.
  if (!Array.isArray(current.promptMessageIds) || current.promptMessageIds.filter(id => id === receipt.prompt_message_id).length !== 1
    || !Array.isArray(prior.promptMessageIds) || prior.promptMessageIds.includes(receipt.prompt_message_id)) return null;
  const details = [
    { name: "Provenance", value: "Cursor native turnEnded observations; partial, unsummed, unverified counter semantics" },
    { name: "Partial reasons", value: receipt.receipt.reasons.join(", ") },
    { name: "Collector truncated", value: String(receipt.receipt.truncated) },
    ...Array.from({ length: Math.ceil(receipt.receipt.observations.length / 8) }, (_, group) => ({
      name: `Native observations ${group * 8 + 1}-${Math.min((group + 1) * 8, receipt.receipt.observations.length)}`,
      value: JSON.stringify(receipt.receipt.observations.slice(group * 8, (group + 1) * 8)),
    })),
  ];
  // Eight closed observations fit within each 4,000-byte detail, without dropping any counters.
  return {
    eventType: "provider.notice.recorded", itemId,
    payload: { schema: "paperclip.provider.notice.v1", noticeId: itemId, severity: "info", category: "cursor_native_usage_observed", scope: "turn", recoverable: true, userActionable: false,
      summary: "Cursor reported partial native counters. These observations are not authoritative token usage or billing cost.", details },
  };
}
