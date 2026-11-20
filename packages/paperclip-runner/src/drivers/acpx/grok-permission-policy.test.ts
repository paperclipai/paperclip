import { describe, expect, it } from "vitest";
import { createGrokPermissionGuard, GROK_PERMISSION_BYPASS_MODES } from "./grok-permission-policy.js";
import { createGrokSessionOpenGuard } from "./grok-session-rules.js";
import { acpxInternals } from "../../../test/support/acpx-bundle-internals.mjs";

const { AcpClient } = await acpxInternals(["AcpClient"]);
const violation = expect.objectContaining({ code: "GROK_POLICY_VIOLATION", retryable: false });

function sessionsChanged(yolo: unknown) {
  return { jsonrpc: "2.0", method: "_x.ai/sessions/changed", params: { upserted: [
    { sessionId: "s", modelId: "grok-4.7", reasoningEffort: "high", ...(yolo === undefined ? {} : { yolo }), activity: "idle" },
  ], removed: [] } };
}

describe("Grok permission policy", () => {
  it.each(["session/new", "session/load", "session/resume"])("removes a client yoloMode request from %s before it reaches Grok", method => {
    const open = createGrokSessionOpenGuard({ rules: "Follow the task.", model: "grok-4.7" });
    const guard = createGrokPermissionGuard();
    const request = { id: 1, method, params: { sessionId: "s", cwd: "/w", _meta: { yoloMode: true, autoMode: true } } };
    open("outbound", request);
    guard("outbound", request);
    expect(request.params._meta).not.toHaveProperty("yoloMode");
    expect(request.params._meta).not.toHaveProperty("autoMode");
  });

  it("fails closed when Grok reports a yolo session and stays failed", () => {
    const guard = createGrokPermissionGuard();
    expect(() => guard("inbound", sessionsChanged(true))).toThrow(violation);
    expect(() => guard("inbound", sessionsChanged(false))).toThrow(violation);
    expect(() => guard("outbound", { id: 2, method: "session/prompt", params: { sessionId: "s" } })).toThrow(violation);
  });

  it.each([...GROK_PERMISSION_BYPASS_MODES])("fails closed on a %s mode update or request", mode => {
    const inbound = createGrokPermissionGuard();
    expect(() => inbound("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: mode } } }))
      .toThrow(violation);
    const outbound = createGrokPermissionGuard();
    expect(() => outbound("outbound", { id: 3, method: "session/set_mode", params: { sessionId: "s", modeId: mode } })).toThrow(violation);
  });

  it("admits normal Grok traffic", () => {
    const guard = createGrokPermissionGuard();
    for (const [direction, message] of [
      ["outbound", { id: 1, method: "session/new", params: { cwd: "/w", _meta: { rules: "", modelId: "grok-4.7" } } }],
      ["inbound", { id: 1, result: { sessionId: "s", models: { currentModelId: "grok-4.7" } } }],
      ["inbound", sessionsChanged(false)],
      ["inbound", sessionsChanged(undefined)],
      ["inbound", { method: "_x.ai/sessions/changed", params: { upserted: [], removed: ["old"] } }],
      ["inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: "ask" } } }],
      ["inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "yolo" } } } }],
      ["outbound", { id: 2, method: "session/set_mode", params: { sessionId: "s", modeId: "ask" } }],
      ["outbound", { id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "/yolo" }] } }],
    ] as const) guard(direction, message);
  });

  it("tears down the stock ACPX stream before a yolo report reaches the SDK", async () => {
    const client = new AcpClient({
      cwd: "/tmp", agentCommand: "fixture-never-spawned", permissionMode: "deny-all",
      protocolGuardFactory: () => createGrokPermissionGuard(),
    });
    let inbound!: ReadableStreamDefaultController;
    const stream = client.createTappedStream({
      readable: new ReadableStream({ start(controller) { inbound = controller; } }),
      writable: new WritableStream(),
    });
    const reader = stream.readable.getReader();
    const update = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } };
    inbound.enqueue(sessionsChanged(false));
    inbound.enqueue(update);
    await expect(reader.read()).resolves.toEqual({ done: false, value: update });
    inbound.enqueue(sessionsChanged(true));
    await expect(reader.read()).rejects.toThrow(violation);
  });
});
