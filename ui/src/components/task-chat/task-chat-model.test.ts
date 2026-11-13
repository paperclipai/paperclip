import { describe, expect, it } from "vitest";

import {
  latestPendingRuntimeRequest,
  runtimeRequestReplacesComposerSkip,
  type TaskChatRuntimeRequestItem,
} from "./task-chat-model";

function runtimeRequest(
  requestId: string,
  status: TaskChatRuntimeRequestItem["status"],
): TaskChatRuntimeRequestItem {
  return {
    id: `${requestId}:${status}`,
    kind: "protocol",
    surface: "runtime_request",
    runId: "run-1",
    requestId,
    requestKind: "runtime",
    turnId: "turn-1",
    requestType: "input",
    status,
    prompt: "Choose",
    choices: [],
    fields: [],
  };
}

describe("latestPendingRuntimeRequest", () => {
  it("suppresses a stale pending card after every terminal lifecycle outcome", () => {
    for (const status of ["resolved", "expired", "cancelled"] as const) {
      expect(
        latestPendingRuntimeRequest([
          runtimeRequest("request-1", "pending"),
          runtimeRequest("request-1", status),
        ]),
      ).toBeNull();
    }
  });

  it("retains another request that is still pending", () => {
    expect(
      latestPendingRuntimeRequest([
        runtimeRequest("request-1", "pending"),
        runtimeRequest("request-2", "pending"),
        runtimeRequest("request-2", "resolved"),
      ]),
    ).toMatchObject({ requestId: "request-1", status: "pending" });
  });
});

describe("runtimeRequestReplacesComposerSkip", () => {
  it("uses an explicit denial choice instead of showing a redundant composer Skip", () => {
    expect(
      runtimeRequestReplacesComposerSkip({
        ...runtimeRequest("permission-1", "pending"),
        requestType: "permission",
        choices: [
          { key: "accept", label: "Allow once" },
          { key: "decline", label: "Deny" },
        ],
      }),
    ).toBe(true);
  });

  it("keeps Skip for runtime input without a negative choice", () => {
    expect(
      runtimeRequestReplacesComposerSkip(runtimeRequest("input-1", "pending")),
    ).toBe(false);
  });
});
