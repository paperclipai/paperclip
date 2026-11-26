import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as copilotEvents from "./copilot-events.js";
import { COPILOT_ACP_EVENT_METHOD } from "./copilot-events.js";
import { createCopilotProfileExtensionAdapter } from "./copilot-extension-adapter.js";
import { validateAcpxRichEvent } from "./profile-extensions.js";

const context = { workspacePath: "/workspace", sessionId: "session-1", turnId: "turn-1" };
const params = (type: string, data: unknown, extra = {}) => ({ sessionId: context.sessionId, type, data, ...extra });

describe("Copilot display extension adapter", () => {
  it("preserves subagent lifecycle details as session notices without invented turn provenance", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const started = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("subagent.started", { agentName: "review", agentDisplayName: "Reviewer", toolCallId: "tool-1", agentDescription: "Review the change", model: "exact-model", resumable: true }, { agentId: "agent-2" }));
    const completed = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("subagent.completed", { agentName: "review", toolCallId: "tool-1", model: "exact-model", totalToolCalls: 3, durationMs: 12.5, totalTokens: 40, modelSelectionSource: "agent" }, { agentId: "agent-2", timestamp: "2026-09-28T00:00:00Z" }));
    [...started, ...completed].forEach(validateAcpxRichEvent);
    expect(started.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(completed.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(started[0].itemId).not.toBe(completed[0].itemId);
    expect(completed[0].payload).toMatchObject({
      scope: "session",
      details: expect.arrayContaining([{ name: "totalTokens", value: "40" }, { name: "durationMs", value: "12.5" }, { name: "modelSelectionSource", value: "agent" }, { name: "source.agentId", value: "agent-2" }, { name: "source.timestamp", value: "2026-09-28T00:00:00Z" }]),
    });
  });

  it("does not assign delayed usage, delegation, or artifact activity to the next receiving turn", async () => {
    const next = createCopilotProfileExtensionAdapter({ ...context, turnId: "turn-2" });
    for (const [type, data] of [
      ["assistant.usage", { inputTokens: 42 }],
      ["subagent.completed", { toolCallId: "previous-tool", totalTokens: 42 }],
      ["session.workspace_file_changed", { path: "previous.md", operation: "create" }],
      ["session.compaction_complete", { success: true, preCompactionTokens: 42 }],
    ] as const) {
      const events = await next.notification(COPILOT_ACP_EVENT_METHOD, params(type, data, { timestamp: "2026-09-28T00:00:00Z" }));
      events.forEach(validateAcpxRichEvent);
      expect(events.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
      expect(events[0].payload.scope).toBe("session");
      expect(events[0].payload).not.toHaveProperty("provenance");
      expect(events[0].payload.details).toContainEqual({ name: "source.sessionId", value: "session-1" });
      expect(events[0].payload.details).toContainEqual({ name: "turnAttribution", value: "unknown: provider session notification has no originating turn ID" });
      expect(JSON.stringify(events)).not.toContain("turn-2");
    }
  });

  it("does not register provider-session paths or binary assets as task artifacts", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const file = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.workspace_file_changed", { operation: "create", path: "reports/result.md" }));
    file.forEach(validateAcpxRichEvent);
    expect(file.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(file[0].payload).toMatchObject({ scope: "session" });
    expect(file[0].payload.details).toEqual(expect.arrayContaining([{ name: "path", value: "reports/result.md" }, { name: "locationKind", value: "provider_session_workspace" }]));
    expect(await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.workspace_file_changed", { operation: "create", path: "../../secret" }))).toEqual([]);
    const bytes = Buffer.from("image fixture");
    const asset = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.binary_asset", { assetId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, type: "image", mimeType: "image/png", byteLength: bytes.length, data: bytes.toString("base64") }));
    asset.forEach(validateAcpxRichEvent);
    expect(asset[0].payload.details).toContainEqual({ name: "mimeType", value: "image/png" });
    expect(JSON.stringify(asset)).not.toContain(bytes.toString("base64"));
  });

  it("keeps supplemental non-dollar usage separate from authoritative terminal accounting", async () => {
    const events = await createCopilotProfileExtensionAdapter(context).notification(COPILOT_ACP_EVENT_METHOD, params("assistant.usage", { model: "m", inputTokens: 10, outputTokens: 2, cost: 3, copilotUsage: { totalNanoAiu: 50 }, quotaSnapshots: { private: "secret" } }));
    events.forEach(validateAcpxRichEvent);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("provider.notice.recorded");
    expect(events[0].payload.details).toEqual(expect.arrayContaining([{ name: "modelMultiplier", value: "3" }, { name: "totalNanoAiu", value: "50" }, { name: "inputTokens", value: "10" }, { name: "accounting", value: "supplemental_provider_notice" }]));
    expect(JSON.stringify(events)).not.toMatch(/costUsd|quotaSnapshots|secret/);
  });

  it("redacts credentials in provider strings while preserving numeric token counters", async () => {
    const events = await createCopilotProfileExtensionAdapter(context).notification(COPILOT_ACP_EVENT_METHOD, params("subagent.failed", { agentName: "review", totalTokens: 42, error: "Authorization: Bearer secretsecretsecret", model: "ghp_abcdefghijklmnopqrstuvwxyz" }));
    events.forEach(validateAcpxRichEvent);
    expect(JSON.stringify(events)).not.toMatch(/secretsecretsecret|ghp_abcdefghijklmnopqrstuvwxyz/);
    expect(events[0].payload.details).toContainEqual({ name: "totalTokens", value: "42" });
  });

  it("reports native unsupported input honestly and ignores unrelated or cross-session notifications", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    await expect(adapter.request("user_input.requested", {})).rejects.toThrow("no qualified");
    const events = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("user_input.requested", { requestId: "q-1", question: "Do not fabricate an input form" }));
    events.forEach(validateAcpxRichEvent);
    expect(events[0].payload).toMatchObject({ severity: "warning", userActionable: false });
    expect(JSON.stringify(events)).not.toContain("Do not fabricate");
    expect(await adapter.notification("unrelated/event", {})).toEqual([]);
    expect(await adapter.notification(COPILOT_ACP_EVENT_METHOD, { ...params("session.idle", {}), sessionId: "another" })).toEqual([]);
  });

  it("redacts sensitive field paths even when their plain values have no recognizable credential prefix", async () => {
    // Exercise the display boundary independently from today's closed native
    // field list, so a future projected field cannot bypass keyed redaction.
    const normalize = vi.spyOn(copilotEvents, "normalizeCopilotSessionEvent").mockReturnValueOnce({
      kind: "usage", sourceMethod: COPILOT_ACP_EVENT_METHOD, sourceType: "assistant.usage",
      sessionId: context.sessionId, turnId: null,
      data: { connectionString: "plain-credential-value", credentials: { endpoint: "opaque-value" }, nested: { apiKey: { endpoint: "nested-secret" } }, inputTokens: 42 },
    });
    try {
      const events = await createCopilotProfileExtensionAdapter(context).notification(COPILOT_ACP_EVENT_METHOD, params("assistant.usage", {}));
      events.forEach(validateAcpxRichEvent);
      expect(events[0].payload.details).toEqual(expect.arrayContaining([
        { name: "connectionString", value: "[REDACTED]" },
        { name: "credentials.endpoint", value: "[REDACTED]" },
        { name: "nested.apiKey.endpoint", value: "[REDACTED]" },
        { name: "inputTokens", value: "42" },
      ]));
      expect(JSON.stringify(events)).not.toMatch(/plain-credential-value|opaque-value|nested-secret/);
    } finally { normalize.mockRestore(); }
  });

  it("preserves compaction success and failure as session notices and keeps settlement nonterminal", async () => {
    const adapter = createCopilotProfileExtensionAdapter(context);
    const success = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.compaction_complete", { success: true, preCompactionTokens: 100, postCompactionTokens: 40, checkpointNumber: 1 }));
    success.forEach(validateAcpxRichEvent);
    expect(success.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(success[0].payload.details).toEqual(expect.arrayContaining([{ name: "preCompactionTokens", value: "100" }, { name: "postCompactionTokens", value: "40" }, { name: "success", value: "true" }]));
    const failure = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.compaction_complete", { success: false }));
    expect(failure.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    const idle = await adapter.notification(COPILOT_ACP_EVENT_METHOD, params("session.idle", {}));
    expect(idle.map(event => event.eventType)).toEqual(["provider.notice.recorded"]);
    expect(idle[0].payload.details).toContainEqual({ name: "authoritativeTurnCompletion", value: "false" });
  });
});
