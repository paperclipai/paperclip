import { describe, expect, it, vi } from "vitest";
import { liveAcpxRuntimeRequests } from "./runnerd-codex-transport.js";
import { FakeCodexTransport, makeDriver, WORKSPACE } from "../drivers/codex/codex-app-server-driver.test-support.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import type { CodexRpcServerRequest } from "../drivers/codex/app-server-transport.js";

function snapshot() {
  return {
    provider: "acpx", runtimeRequestsLive: true,
    driverSessionId: "thread-1", activeProviderTurnId: "turn-1", runtimeRequestTurnId: "durable-turn-1",
    pendingRuntimeRequests: [{
      schema: "paperclip.runtime_request.v2", requestId: "input-1", type: "input",
      requestKind: "runtime", status: "pending", turnId: "durable-turn-1", itemId: "question-1",
      origin: { adapter: "acpx-runtime-sidecar", provider: "pi", method: "elicitation/create" },
      input: { schema: "paperclip.question_set.v1", questions: [
        { id: "answer", prompt: "Give the answer", required: true, answerMode: "text" },
      ] },
    }, {
      schema: "paperclip.runtime_request.v2", requestId: "permission-1", type: "permission",
      requestKind: "permission_approval", status: "pending", turnId: "durable-turn-1", itemId: "write-1",
      prompt: "Allow this write?", choices: [{ key: "deny", label: "Decline", outcome: "cancel" }],
      details: { toolCallId: "write-1" },
      origin: { adapter: "acpx-runtime-sidecar", provider: "pi", method: "session/request_permission" },
    }],
  };
}

describe("live ACP request recovery", () => {
  it("retains original question, option and permission identities", () => {
    const value = snapshot();
    const requests = liveAcpxRuntimeRequests(value, "thread-1", "turn-1", "durable-turn-1");
    expect(requests.map(request => [request.id, request.method])).toEqual([
      ["input-1", "elicitation/create"], ["permission-1", "session/request_permission"],
    ]);
    expect(requests.every(request => request.params.turnId === "turn-1")).toBe(true);
    expect(requests[0]!.params.questionSet).toEqual(value.pendingRuntimeRequests[0]!.input);
    expect(requests[1]!.params).toMatchObject({ choices: value.pendingRuntimeRequests[1]!.choices, toolCallId: "write-1" });
  });

  it.each([
    ["missing live attestation", { runtimeRequestsLive: false }],
    ["wrong provider", { provider: "codex" }],
    ["wrong session", { driverSessionId: "other" }],
    ["wrong provider turn", { activeProviderTurnId: "other" }],
    ["wrong durable turn", { runtimeRequestTurnId: "other" }],
    ["missing ledger", { pendingRuntimeRequests: null }],
  ])("rejects %s", (_name, change) => {
    expect(() => liveAcpxRuntimeRequests({ ...snapshot(), ...change }, "thread-1", "turn-1", "durable-turn-1")).toThrow();
  });

  it.each([
    { requestId: "" }, { status: "resolved" }, { turnId: "old-turn" },
    { schema: "paperclip.runtime_request.v1" }, { type: "permission" },
    { origin: { method: "item/tool/call" } }, { input: null },
  ])("rejects malformed or stale callback %j", change => {
    const value = snapshot();
    expect(() => liveAcpxRuntimeRequests({ ...value, pendingRuntimeRequests: [{ ...value.pendingRuntimeRequests[0], ...change }] }, "thread-1", "turn-1", "durable-turn-1")).toThrow();
  });

  it("rejects duplicate or oversized callback ledgers", () => {
    const value = snapshot();
    for (const count of [2, 1025]) {
      expect(() => liveAcpxRuntimeRequests({ ...value, pendingRuntimeRequests: Array(count).fill(value.pendingRuntimeRequests[0]) }, "thread-1", "turn-1", "durable-turn-1")).toThrow();
    }
  });

  it.each(["input-1", "permission-1"])("restores and delivers %s once after controller recovery", async requestId => {
    const requests = liveAcpxRuntimeRequests(snapshot(), "thread-1", "turn-1", "durable-turn-1");
    const originalTransport = new FakeCodexTransport();
    const original = await makeDriver([originalTransport]).openSession({ runId: "run-1", normalizedSessionId: "session-1", workingDirectory: WORKSPACE });
    let recovered: Awaited<ReturnType<typeof original.snapshot>> | undefined;
    try {
      await original.startTurn({ message: { role: "user", text: "Wait for input" } });
      for (const request of requests) void originalTransport.invoke(request);
      await Promise.resolve();
      recovered = await original.snapshot();
      expect(recovered.pendingRuntimeRequests).toHaveLength(2);
    } finally {
      await original.close();
    }
    class AdoptedTransport extends FakeCodexTransport {
      takeRestoredRuntimeRequests(): CodexRpcServerRequest[] { return requests; }
    }
    const transport = new AdoptedTransport();
    const deliver = vi.fn(async () => {});
    transport.runtimeRequestResolver = deliver;
    const recovery = await makeDriver([transport]).recoverSession(recovered!);
    expect(recovery.recovered).toBe(true);
    const session = recovery.session!;
    const recoveredEvents: PrpEvent[] = [];
    const drained = (async () => { for await (const event of session.events()) recoveredEvents.push(event); })();
    try {
      expect(session.pendingRuntimeRequests?.().map(request => request.requestId)).toEqual(["input-1", "permission-1"]);
      const resolution = requestId === "input-1"
        ? { action: "submit" as const, content: { schema: "paperclip.question_response.v1", answers: { answer: { text: "undisclosed answer" } } } }
        : { action: "decline" as const };
      await session.resolveRuntimeRequest?.({ requestId, turnId: "turn-1", resolution });
      expect(deliver).toHaveBeenCalledExactlyOnceWith({ requestId, turnId: "turn-1", resolution });
      await expect(session.resolveRuntimeRequest?.({ requestId, turnId: "turn-1", resolution })).rejects.toThrow("no longer pending");
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      await session.close(); await drained;
      expect(recoveredEvents.map(event => event.eventType)).not.toContain("runtime_request.created");
      expect(recoveredEvents.filter(event => event.eventType === "runtime_request.expired").map(event => event.payload.requestId)).not.toContain(requestId);
    }
  });
});
