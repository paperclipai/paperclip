import { describe, expect, it } from "vitest";
import { CapabilityMockControlPlaneAdapter } from "./capability-mock-control-plane-adapter.js";

describe("mock backlog task creation", () => {
  it.each([false, true])("preserves an explicit hold and dependencies (blocked=%s)", async blocked => {
    const adapter = new CapabilityMockControlPlaneAdapter();
    const base = adapter.snapshot();
    await adapter.start();
    await adapter.openFixtureRun({ identity: { runId: "run-1", sessionId: "session-1", companyId: base.company.id, issueId: base.tasks[0]!.id, agentId: base.actors[0]!.id }, backendKind: "mock", sourceInstanceId: "backlog-test", capabilities: ["delegation:tasks:create"] });
    const call = { runId: "run-1", idempotencyKey: "later", command: { kind: "create_task" as const, title: "Later", status: "backlog" as const, assigneeActorId: base.actors[0]!.id, blockedByTaskIds: blocked ? [base.tasks[0]!.id] : [] } };
    const receipt = await adapter.applyCommand(call);
    await adapter.applyCommand(call);
    const state = adapter.snapshot();
    expect(state.tasks).toHaveLength(base.tasks.length + 1);
    expect(state.tasks.find(task => task.title === "Later")).toMatchObject({ status: "backlog", executionRunId: null, startedAt: null });
    expect(receipt.scheduledWakeIds).toEqual([]);
    expect(state.wakes).toEqual(base.wakes);
    expect(state.blockers).toHaveLength(base.blockers.length + (blocked ? 1 : 0));
  });
});
