import type { CanonicalProviderEvent } from "../provider-events.js";

const SUMMARY = "Cursor reported partial native counters. These observations are not authoritative token usage or billing cost.";
const PROVENANCE = "Cursor native turnEnded observations; partial, unsummed, unverified counter semantics";
const REASONS = new Set([
  "native_counter_semantics_unverified", "native_counters_missing", "invalid_native_counter",
  "multiple_terminal_observations", "native_terminal_not_observed", "observation_limit_reached",
  "child_run_attribution_unverified",
]);
const COUNTERS = new Set(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/**
 * The eval transport wraps rich events in a Codex-shaped notification. Admit
 * only the closed Cursor diagnostic, never arbitrary canonical provider data.
 * This notice no longer contains the private prompt/request receipt IDs, so
 * validate its projected shape without inventing a persisted usage receipt.
 * Neither these unsummed observations nor their absence are accounting facts.
 */
export function cursorUsageNotice(
  raw: unknown,
  owner: { provider?: string; agent?: string; threadId: string; turnId: string | null },
): CanonicalProviderEvent | null {
  try {
    if (owner.provider !== "acpx" || owner.agent !== "cursor" || !owner.threadId || !owner.turnId
      || !object(raw) || !exact(raw, ["threadId", "turnId", "eventType", "itemId", "payload"])
      || raw.threadId !== owner.threadId || raw.turnId !== owner.turnId
      || raw.eventType !== "provider.notice.recorded" || typeof raw.itemId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(raw.itemId)) return null;
    // Runnerd's envelope item is the durable authority item. The native notice
    // keeps its own display identity inside the payload; these are independent.
    const p = raw.payload;
    if (!object(p) || !exact(p, ["schema", "noticeId", "severity", "category", "scope", "recoverable", "userActionable", "summary", "details"])
      || p.schema !== "paperclip.provider.notice.v1" || typeof p.noticeId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(p.noticeId)
      || p.severity !== "info" || p.category !== "cursor_native_usage_observed" || p.scope !== "turn"
      || p.recoverable !== true || p.userActionable !== false || p.summary !== SUMMARY
      || !Array.isArray(p.details) || p.details.length < 3 || p.details.length > 11) return null;
    // Bound strings before JSON parsing/cloning. The collector's complete
    // envelope is <=16 KiB; its observation strings cannot exceed that budget.
    const details: Array<{ name: string; value: string }> = [];
    let bytes = 0;
    for (const detail of p.details) {
      if (!object(detail) || !exact(detail, ["name", "value"]) || typeof detail.name !== "string"
        || detail.name.length > 64 || typeof detail.value !== "string" || detail.value.length > 4_000) return null;
      bytes += Buffer.byteLength(detail.value, "utf8");
      if (bytes > 16_384) return null;
      details.push({ name: detail.name, value: detail.value });
    }
    if (details[0]!.name !== "Provenance" || details[0]!.value !== PROVENANCE
      || details[1]!.name !== "Partial reasons" || details[2]!.name !== "Collector truncated"
      || !["true", "false"].includes(details[2]!.value)) return null;
    const reasons = details[1]!.value.split(", ");
    if (!reasons.includes("native_counter_semantics_unverified") || reasons.length > REASONS.size
      || new Set(reasons).size !== reasons.length || !reasons.every(reason => REASONS.has(reason))) return null;
    const invocations = new Map<string, { role: string; nativeRun: number; sequence: number }>();
    let count = 0;
    const retained = details.slice(0, 3);
    for (let group = 3; group < details.length; group++) {
      const values: unknown = JSON.parse(details[group]!.value);
      if (!Array.isArray(values) || values.length < 1 || values.length > 8
        || (group < details.length - 1 && values.length !== 8)) return null;
      if (details[group]!.name !== `Native observations ${count + 1}-${count + values.length}`) return null;
      const observations = [];
      for (const value of values) {
        if (!object(value) || !exact(value, ["invocationId", "role", "nativeRun", "sequence", "counters"])
          || typeof value.invocationId !== "string" || !/^invocation-([1-9]|[1-5][0-9]|6[0-4])$/.test(value.invocationId)
          || (value.role !== "parent" && value.role !== "child") || !positive(value.nativeRun)
          || !positive(value.sequence) || !object(value.counters)) return null;
        const counters: Record<string, number> = {};
        for (const [key, number] of Object.entries(value.counters)) {
          if (!COUNTERS.has(key) || !Number.isSafeInteger(number) || Number(number) < 0) return null;
          counters[key] = Number(number);
        }
        const prior = invocations.get(value.invocationId);
        if (prior && (prior.role !== value.role || prior.nativeRun !== value.nativeRun || prior.sequence >= value.sequence)) return null;
        invocations.set(value.invocationId, { role: value.role, nativeRun: value.nativeRun, sequence: value.sequence });
        observations.push({ invocationId: value.invocationId, role: value.role, nativeRun: value.nativeRun, sequence: value.sequence, counters });
      }
      count += observations.length;
      if (count > 64) return null;
      retained.push({ name: details[group]!.name, value: JSON.stringify(observations) });
    }
    return {
      eventType: "provider.notice.recorded", itemId: raw.itemId,
      payload: { schema: "paperclip.provider.notice.v1", noticeId: p.noticeId, severity: "info",
        category: "cursor_native_usage_observed", scope: "turn", recoverable: true, userActionable: false,
        summary: SUMMARY, details: retained },
    };
  } catch {
    // Optional diagnostics, including malformed JSON, cannot poison settlement.
    return null;
  }
}
