import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COPILOT_ACP_CLIENT_CAPABILITIES, COPILOT_ACP_EVENT_METHOD, normalizeCopilotSessionEvent } from "./copilot-events.js";

const binding = { sessionId: "session-1", turnId: "turn-1" };
const event = (type: string, data: unknown, extra = {}) => ({ method: COPILOT_ACP_EVENT_METHOD, params: { sessionId: "session-1", type, data, ...extra } });

describe("Copilot native event projection", () => {
  it("subscribes explicitly and requires an active receiver without inventing originating turn", () => {
    const events = COPILOT_ACP_CLIENT_CAPABILITIES._meta["github.com/copilot"].events;
    expect(events).toContain("session.workspace_file_changed");
    expect(events).not.toContain("assistant.reasoning");
    expect(normalizeCopilotSessionEvent(event("session.idle", {}), { ...binding, sessionId: "other" })).toBeNull();
    expect(normalizeCopilotSessionEvent(event("session.idle", {}), { ...binding, turnId: "" })).toBeNull();
    expect(normalizeCopilotSessionEvent(event("assistant.reasoning", { text: "private" }), binding)).toBeNull();
  });
  it("retains session evidence without treating receipt or provider payload as originating turn", () => {
    const delayed = event("assistant.usage", { inputTokens: 10 }, { turnId: "unqualified-provider-field" });
    const earlier = normalizeCopilotSessionEvent(delayed, binding);
    const later = normalizeCopilotSessionEvent(delayed, { ...binding, turnId: "next-turn" });
    expect(earlier).toEqual(later);
    expect(later).toMatchObject({ sessionId: "session-1", turnId: null, data: { inputTokens: 10 } });
  });
  it("preserves subagent attribution and useful metrics while dropping undeclared fields", () => {
    expect(normalizeCopilotSessionEvent(event("subagent.completed", { toolCallId: "t", agentName: "review", agentDisplayName: "Reviewer", model: "m", totalTokens: 42, cancelled: true, private: "secret" }, { agentId: "child" }), binding)).toMatchObject({ kind: "activity", agentId: "child", data: { model: "m", totalTokens: 42, cancelled: true } });
    expect(normalizeCopilotSessionEvent(event("subagent.completed", { private: "secret" }), binding)?.data).not.toHaveProperty("private");
  });
  it("does not conflate provider workspace artifacts with task files", () => {
    const result = normalizeCopilotSessionEvent(event("session.workspace_file_changed", { path: "reports/result.md", operation: "create" }), binding);
    expect(result).toMatchObject({ kind: "artifact_reference", data: { path: "reports/result.md", locationKind: "provider_session_workspace", requiresArtifactResolution: true } });
    for (const path of ["../secret", "/etc/passwd", "C:\\secret", "file:///secret", "a/../secret", "a//b", "a\nsecret"]) {
      expect(normalizeCopilotSessionEvent(event("session.workspace_file_changed", { path, operation: "create" }), binding)).toBeNull();
    }
  });
  it("verifies binary asset identity and emits metadata without inline bytes", () => {
    const bytes = Buffer.from("test image");
    const data = { assetId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, type: "image", mimeType: "image/png", byteLength: bytes.length, data: bytes.toString("base64") };
    expect(normalizeCopilotSessionEvent(event("session.binary_asset", data), binding)).toMatchObject({ kind: "artifact_reference", data: { assetId: data.assetId, byteLength: bytes.length } });
    expect(normalizeCopilotSessionEvent(event("session.binary_asset", data), binding)?.data).not.toHaveProperty("data");
    expect(normalizeCopilotSessionEvent(event("session.binary_asset", { ...data, data: "invalid" }), binding)).toBeNull();
    expect(normalizeCopilotSessionEvent(event("session.binary_asset", { ...data, byteLength: 99 }), binding)).toBeNull();
  });
  it("keeps cost units explicit and avoids duplicate authoritative usage", () => {
    expect(normalizeCopilotSessionEvent(event("assistant.usage", { inputTokens: 10, outputTokens: 2, cost: 3, copilotUsage: { totalNanoAiu: 4 }, quotaSnapshots: { secret: true } }), binding)?.data).toEqual({ inputTokens: 10, outputTokens: 2, modelMultiplier: 3, totalNanoAiu: 4, accounting: "supplemental_provider_notice" });
  });
  it("does not finalize turns from lossy events or invent responders for native input", () => {
    expect(normalizeCopilotSessionEvent(event("session.idle", {}), binding)?.data.authoritativeTurnCompletion).toBe(false);
    expect(normalizeCopilotSessionEvent(event("user_input.requested", { requestId: "q", question: "private question" }), binding)).toMatchObject({ kind: "capability_gap", data: { reason: "native_request_has_no_qualified_acp_responder", requestId: "q" } });
    expect(normalizeCopilotSessionEvent(event("session.plan_changed", {}, { dataOmitted: "too-large" }), binding)).toMatchObject({ kind: "capability_gap", data: { omission: "too-large" } });
  });
  it("rejects oversized and cyclic notifications", () => {
    expect(normalizeCopilotSessionEvent(event("session.idle", { text: "x".repeat(50 * 1024) }), binding)).toBeNull();
    const data: Record<string, unknown> = {}; data.self = data;
    expect(normalizeCopilotSessionEvent(event("session.idle", data), binding)).toBeNull();
  });
  it("preserves fractional usage latency and compaction counters without private summaries", () => {
    expect(normalizeCopilotSessionEvent(event("assistant.usage", { duration: 1.5, timeToFirstTokenMs: 12.25 }), binding)?.data).toMatchObject({ duration: 1.5, timeToFirstTokenMs: 12.25 });
    expect(normalizeCopilotSessionEvent(event("session.compaction_complete", { success: true, tokensRemoved: 50, summaryContent: "private", checkpointPath: "/private" }), binding)?.data).toEqual({ tokensRemoved: 50, success: true });
    expect(normalizeCopilotSessionEvent(event("session.permissions_changed", { mode: "allow_all", previousMode: "default" }), binding)?.data).toEqual({ previousMode: "default", mode: "allow_all", policyChangeAllowed: false });
  });
});
