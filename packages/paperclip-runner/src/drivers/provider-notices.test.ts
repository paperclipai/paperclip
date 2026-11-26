import { describe, expect, it } from "vitest";
import { normalizeProviderNotice } from "./provider-notices.js";

const owner = { provider: "acpx", agent: "cursor", threadId: "thread", turnId: "turn" };
function notice() {
  return {
    threadId: "thread", turnId: "turn", eventType: "provider.notice.recorded", itemId: "item",
    payload: { schema: "paperclip.provider.notice.v1", noticeId: "notice", severity: "info",
      category: "cursor_native_usage_observed", scope: "turn", recoverable: true, userActionable: false,
      summary: "Cursor reported partial native counters. These observations are not authoritative token usage or billing cost.",
      details: [
        { name: "Provenance", value: "Cursor native turnEnded observations; partial, unsummed, unverified counter semantics" },
        { name: "Partial reasons", value: "native_counter_semantics_unverified" },
        { name: "Collector truncated", value: "false" },
        { name: "Native observations 1-1", value: JSON.stringify([{ invocationId: "invocation-1", role: "parent", nativeRun: 1, sequence: 1, counters: { inputTokens: 20 } }]) },
      ] },
  };
}

describe("provider-owned optional notice normalization", () => {
  it("retains partial counters as diagnostics without promoting them into accounting", () => {
    const raw = notice(), result = normalizeProviderNotice(raw, owner);
    expect(result).toEqual({ eventType: raw.eventType, itemId: raw.itemId, payload: raw.payload });
    expect(result).not.toHaveProperty("costUsd");
    expect(result).not.toHaveProperty("inputTokens");
  });
  it.each([
    { ...owner, provider: "codex" }, { ...owner, agent: "claude" }, { ...owner, agent: "toString" },
    { ...owner, threadId: "other" }, { ...owner, turnId: "other" }, { ...owner, turnId: null },
  ])("rejects another owner or an unqualified adapter: %j", other => {
    expect(normalizeProviderNotice(notice(), other)).toBeNull();
  });
  it("does not admit arbitrary canonical events or malformed optional diagnostics", () => {
    const raw = notice(); raw.payload.category = "some_other_notice";
    expect(normalizeProviderNotice(raw, owner)).toBeNull();
    const malformed = notice(); malformed.payload.details[3]!.value = "not JSON";
    expect(normalizeProviderNotice(malformed, owner)).toBeNull();
    expect(normalizeProviderNotice({ ...notice(), eventType: "turn.completed" }, owner)).toBeNull();
  });
});
