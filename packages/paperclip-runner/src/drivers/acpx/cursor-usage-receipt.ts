import type { CanonicalProviderEvent } from "../../provider-events.js";
import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
