import { describe, expect, it } from "vitest";
import { bridgedAcpxPermissionParams } from "./runnerd-codex-transport.js";
import { boundedCodexValue, redactCodexValue } from "../drivers/codex/codex-boundaries.js";

// Shape retained in runtime_request.created after the sidecar -> Rust boundary.
// The opaque item ID is deliberately different from the native correlation ID.
function retainedPermission(details: unknown = { toolCallId: "call_native-edit-7" }) {
  return {
    requestId: "acpx-request-permission-7",
    type: "permission",
    requestKind: "permission_approval",
    itemId: "acpx-permission-opaque-7",
    prompt: "Change file: result.txt",
    choices: [{ key: "decline", label: "Deny" }, { key: "cancel", label: "Cancel" }],
    origin: { adapter: "acpx-runtime-sidecar", provider: "copilot", method: "session/request_permission" },
    details,
  };
}

function committedEvent(request = retainedPermission()) {
  return {
    eventType: "runtime_request.created",
    envelope: { payload: { payload: { request } } },
  };
}

describe("ACPX permission correlation through the shared runner transport", () => {
  it.each(["copilot", "cursor", "pi"])("preserves the original %s tool ID in the control-plane details", (provider) => {
    const request = retainedPermission();
    request.origin.provider = provider;
    const before = structuredClone(request);
    const params = bridgedAcpxPermissionParams(committedEvent(request), "thread-1", "turn-1")!;
    expect(params).toEqual({
      threadId: "thread-1", turnId: "turn-1", itemId: request.itemId,
      reason: request.prompt, choices: request.choices, origin: request.origin,
      toolCallId: "call_native-edit-7",
    });
    // The existing server-request handler applies these boundaries before
    // emitting HarnessRuntimeRequest.details to the control plane.
    expect(redactCodexValue(boundedCodexValue(params))).toMatchObject({
      itemId: "acpx-permission-opaque-7", toolCallId: "call_native-edit-7",
    });
    expect(request).toEqual(before);
  });

  it.each(["x".repeat(240), "é".repeat(240), " opaque tool ID "])("does not rewrite a valid bounded identity", (toolCallId) => {
    expect(bridgedAcpxPermissionParams(committedEvent(retainedPermission({ toolCallId })), "t", "u")!.toolCallId).toBe(toolCallId);
  });

  it.each([undefined, null, "", " ", 12, true, {}, [], "x".repeat(241), "bad\nID", "bad\0ID", "bad\x7fID", "bad\x85ID"])("does not fabricate correlation for invalid identity %#", (toolCallId) => {
    const request = { ...retainedPermission({ toolCallId }), toolCallId: "wrong-top-level-id" };
    const params = bridgedAcpxPermissionParams(committedEvent(request), "t", "u")!;
    expect(params).not.toHaveProperty("toolCallId");
    expect(params.itemId).toBe(request.itemId);
    expect(params.choices).toEqual(request.choices);
  });

  it.each([null, undefined, [], "tool-id", 12])("does not infer identity from malformed details %#", (details) => {
    const request = { ...retainedPermission(), details };
    expect(bridgedAcpxPermissionParams(committedEvent(request), "t", "u")).not.toHaveProperty("toolCallId");
  });
});

it("does not project unrelated or malformed committed events as permission requests", () => {
  for (const event of [
    { ...committedEvent(), eventType: "runtime_request.resolved" },
    committedEvent({ ...retainedPermission(), type: "question" }),
    committedEvent({ ...retainedPermission(), requestKind: "user_input" }),
    committedEvent({ ...retainedPermission(), origin: { adapter: "acpx-runtime-sidecar", provider: "copilot", method: "cursor/ask_question" } }),
    { eventType: "runtime_request.created", envelope: { payload: null } },
  ]) expect(bridgedAcpxPermissionParams(event, "t", "u")).toBeNull();
});
