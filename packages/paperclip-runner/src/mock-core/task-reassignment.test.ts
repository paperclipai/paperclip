import { describe, expect, it } from "vitest";
import { CapabilityMockControlPlaneAdapter } from "./capability-mock-control-plane-adapter.js";

async function fixture(status: "todo" | "blocked" | "done" = "todo", claims = ["delegation:tasks:assign"]) {
  const base = new CapabilityMockControlPlaneAdapter().snapshot();
  const adapter = new CapabilityMockControlPlaneAdapter({
    actors: [...base.actors, { ...base.actors[0]!, id: "recipient", name: "Recipient" }],
    tasks: [...base.tasks, { ...base.tasks[0]!, id: "target", identifier: "MCK-2", title: "Existing work", status, statusVersion: 0 }],
  });
  await adapter.start();
  await adapter.openFixtureRun({ identity: { runId: "run-1", sessionId: "session-1", companyId: base.company.id, issueId: base.tasks[0]!.id, agentId: base.actors[0]!.id }, backendKind: "mock", sourceInstanceId: "reassignment-test", capabilities: claims });
  const call = { runId: "run-1", idempotencyKey: "handoff", command: { kind: "reassign_task" as const, targetTaskId: "target", assigneeActorId: "recipient", expectedAssigneeActorId: base.actors[0]!.id, expectedStatusVersion: 0, reason: "Recipient owns implementation" } };
  return { adapter, call, base };
}

describe("mock task reassignment conformance", () => {
  it("changes one existing owner, schedules one wake, and deduplicates replay", async () => {
    const { adapter, call } = await fixture();
    const result = await adapter.applyCommand(call);
    await adapter.applyCommand(call);
    const state = adapter.snapshot();
    expect(state.tasks).toHaveLength(2);
    expect(state.tasks.find(task => task.id === "target")).toMatchObject({ assigneeActorId: "recipient", statusVersion: 1, status: "todo" });
    expect(state.wakes).toHaveLength(1);
    expect(result.scheduledWakeIds).toEqual([state.wakes[0]!.id]);
    expect(state.comments.filter(comment => comment.taskId === "target")).toHaveLength(1);
  });
  it("preserves blocked state without a wake", async () => {
    const { adapter, call } = await fixture("blocked");
    await adapter.applyCommand(call);
    expect(adapter.snapshot().tasks.find(task => task.id === "target")).toMatchObject({ status: "blocked", assigneeActorId: "recipient" });
    expect(adapter.snapshot().wakes).toHaveLength(0);
  });
  it.each(["claim", "owner", "version", "self", "terminal", "key-conflict"])("rejects %s without a second ownership effect", async kind => {
    const { adapter, call, base } = await fixture(kind === "terminal" ? "done" : "todo", kind === "claim" ? [] : undefined);
    if (kind === "owner") call.command.expectedAssigneeActorId = "someone-else";
    if (kind === "version") call.command.expectedStatusVersion = 99;
    if (kind === "self") call.command.targetTaskId = base.tasks[0]!.id;
    if (kind === "key-conflict") { await adapter.applyCommand(call); call.command.reason = "Conflicting request"; }
    const before = adapter.snapshot();
    await expect(adapter.applyCommand(call)).rejects.toThrow();
    expect(adapter.snapshot().tasks).toEqual(before.tasks);
    expect(adapter.snapshot().wakes).toEqual(before.wakes);
  });
});
