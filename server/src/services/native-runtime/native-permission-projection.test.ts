import type { Db } from "@paperclipai/db";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { describe, expect, it, vi } from "vitest";
import { projectNativeRuntimeRequest } from "./native-question-bridge.js";

const binding = {
  companyId: "company-1", issueId: "issue-1", runId: "run-1", agentId: "agent-1",
  normalizedSessionId: "session-1", runnerSourceInstanceId: "runner-1",
};

function permissionEvent(): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: "permission-1",
    sourceSeq: 1, sourceKind: "runner", sourceInstanceId: "runner-1", runId: "run-1",
    normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1",
    eventType: "runtime_request.created", priority: 0, emittedAt: "2026-09-28T12:00:00Z",
    payload: { request: {
      schema: "paperclip.runtime_request.v2", requestKind: "permission_approval", type: "permission",
      requestId: "permission-1", turnId: "turn-1", itemId: "item-1", status: "pending",
      prompt: "Allow editing src/example.ts?",
      choices: [{ key: "accept", label: "Allow once" }, { key: "decline", label: "Deny" }],
      details: { toolCallId: "tool-1" },
      origin: { adapter: "acpx-runtime-sidecar", provider: "acpx", method: "session/request_permission" },
    } },
  };
}

describe("native permission projection", () => {
  it("admits the existing privileged runtime card without a human-only question mutation", async () => {
    const event = permissionEvent();
    const original = structuredClone(event);
    const select = vi.fn();
    await expect(projectNativeRuntimeRequest({ db: { select } as unknown as Db, binding, event })).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(event).toEqual(original);
  });

  it("retains permissions with no provider item identity", async () => {
    const event = permissionEvent();
    delete event.itemId;
    (event.payload.request as Record<string, unknown>).itemId = null;
    await expect(projectNativeRuntimeRequest({ db: {} as Db, binding, event })).resolves.toBeNull();
  });

  it.each([
    { requestKind: "runtime" }, { type: "input" }, { turnId: "stale-turn" }, { itemId: "wrong-item" },
    { requestId: "../../forged" }, { prompt: "" }, { details: [] },
    { choices: [] }, { choices: [{ key: "allow_forever", label: "Always" }] },
    { choices: [{ key: "accept", label: "One" }, { key: "accept", label: "Two" }] },
  ])("rejects malformed or cross-bound permission data %j", async (override) => {
    const event = permissionEvent();
    Object.assign(event.payload.request as object, override);
    await expect(projectNativeRuntimeRequest({ db: {} as Db, binding, event })).rejects.toThrow(/native_runtime_/);
  });

  it.each(["runId", "normalizedSessionId", "sourceInstanceId"] as const)("rejects a foreign %s before dispatch", async (field) => {
    const event = permissionEvent();
    event[field] = "foreign";
    await expect(projectNativeRuntimeRequest({ db: {} as Db, binding, event })).rejects.toThrow("native_runtime_request_binding_mismatch");
  });
});
