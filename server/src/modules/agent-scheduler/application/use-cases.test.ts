import { describe, expect, it, vi } from "vitest";
import type { AgentSchedulerHost, AgentSchedulerWriter, RunnableWakeRow } from "./ports.js";
import {
  AGENT_SCHEDULER_DEQUEUE_REASON,
  AGENT_SCHEDULER_ENQUEUE_REASON,
} from "../domain/policy.js";
import {
  createEvaluateAgentSchedulerAdmission,
  createPromoteAgentRunnableWork,
} from "./use-cases.js";

const BASE_FACTS = {
  schedulerEnabled: true,
  allowParallelExecution: false,
  configuredMaxConcurrentRuns: 20,
  companyId: "company-1",
  agentId: "agent-1",
};

function runnableWake(id: string, overrides: Partial<RunnableWakeRow> = {}): RunnableWakeRow {
  return {
    id,
    companyId: "company-1",
    agentId: "agent-1",
    source: "automation",
    triggerDetail: null,
    reason: null,
    payload: { issueId: `issue-${id}` },
    requestedByActorType: "system",
    requestedByActorId: null,
    idempotencyKey: null,
    requestedAt: new Date("2026-10-08T12:00:00.000Z"),
    ...overrides,
  };
}

function createMemoryWriter(): AgentSchedulerWriter & {
  parked: Array<{ wakeRequestId: string; schedulerMeta: Record<string, unknown> }>;
  runnable: RunnableWakeRow[];
  materialized: Array<{ wakeId: string; runId: string }>;
} {
  const parked: Array<{ wakeRequestId: string; schedulerMeta: Record<string, unknown> }> = [];
  const runnable: RunnableWakeRow[] = [];
  const materialized: Array<{ wakeId: string; runId: string }> = [];

  return {
    parked,
    runnable,
    materialized,
    async listRunnableWakes(_agentId, limit) {
      return runnable.slice(0, limit);
    },
    async parkWakeAsRunnable(input) {
      parked.push({
        wakeRequestId: input.wakeRequestId,
        schedulerMeta: input.schedulerMeta,
      });
      runnable.push(
        runnableWake(input.wakeRequestId, {
          requestedAt: new Date(parked.length * 1000 + Date.now()),
        }),
      );
    },
    async materializeRunnableWake(input) {
      const index = runnable.findIndex((row) => row.id === input.wake.id);
      if (index < 0) return false;
      runnable.splice(index, 1);
      materialized.push({ wakeId: input.wake.id, runId: input.runId });
      return true;
    },
  };
}

function createFakeHost(runningRunCount = 0): AgentSchedulerHost & {
  events: unknown[];
  setRunningCount: (n: number) => void;
} {
  let count = runningRunCount;
  const events: unknown[] = [];
  return {
    events,
    setRunningCount(n: number) {
      count = n;
    },
    async countRunningRunsForAgent() {
      return count;
    },
    async appendSchedulerEvent(input) {
      events.push(input);
    },
  };
}

describe("createEvaluateAgentSchedulerAdmission", () => {
  it("materializes when the agent has a free slot", async () => {
    const writer = createMemoryWriter();
    const host = createFakeHost(0);
    const evaluate = createEvaluateAgentSchedulerAdmission({ host, writer });

    const result = await evaluate({
      ...BASE_FACTS,
      runningRunCount: 0,
      wakeRequestId: "wake-a",
      issueId: "issue-a",
    });

    expect(result).toEqual({ action: "materialize" });
    expect(writer.parked).toHaveLength(0);
    expect(host.events).toHaveLength(0);
  });

  it("parks a second simultaneous assignment while one run is active", async () => {
    const writer = createMemoryWriter();
    const host = createFakeHost(1);
    const evaluate = createEvaluateAgentSchedulerAdmission({ host, writer });

    const result = await evaluate({
      ...BASE_FACTS,
      runningRunCount: 1,
      wakeRequestId: "wake-b",
      issueId: "issue-b",
    });

    expect(result).toEqual({ action: "park", queueDepth: 1 });
    expect(writer.parked).toHaveLength(1);
    expect(writer.parked[0]?.wakeRequestId).toBe("wake-b");
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      kind: "enqueue",
      wakeRequestId: "wake-b",
      queueDepth: 1,
      effectiveCapacity: 1,
    });
  });
});

describe("createPromoteAgentRunnableWork", () => {
  it("promotes the oldest runnable wake when a slot opens after the active run finishes", async () => {
    const writer = createMemoryWriter();
    const host = createFakeHost(0);
    await writer.parkWakeAsRunnable({
      wakeRequestId: "wake-queued",
      companyId: "company-1",
      agentId: "agent-1",
      enqueueReason: AGENT_SCHEDULER_ENQUEUE_REASON,
      schedulerMeta: { parkedAt: new Date().toISOString() },
    });

    const promote = createPromoteAgentRunnableWork({ host, writer });
    const createRunForWake = vi.fn(async (wake: RunnableWakeRow) => `run-for-${wake.id}`);

    const result = await promote({
      schedulerEnabled: true,
      allowParallelExecution: false,
      configuredMaxConcurrentRuns: 20,
      agentId: "agent-1",
      companyId: "company-1",
      createRunForWake,
    });

    expect(result).toEqual({ promoted: 1, runIds: ["run-for-wake-queued"] });
    expect(createRunForWake).toHaveBeenCalledTimes(1);
    expect(writer.materialized).toEqual([{ wakeId: "wake-queued", runId: "run-for-wake-queued" }]);
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toMatchObject({
      kind: "dequeue",
      wakeRequestId: "wake-queued",
      reason: AGENT_SCHEDULER_DEQUEUE_REASON,
      effectiveCapacity: 1,
    });
  });

  it("does not promote while the agent remains at serial capacity", async () => {
    const writer = createMemoryWriter();
    const host = createFakeHost(1);
    await writer.parkWakeAsRunnable({
      wakeRequestId: "wake-waiting",
      companyId: "company-1",
      agentId: "agent-1",
      enqueueReason: AGENT_SCHEDULER_ENQUEUE_REASON,
      schedulerMeta: {},
    });

    const promote = createPromoteAgentRunnableWork({ host, writer });
    const result = await promote({
      schedulerEnabled: true,
      allowParallelExecution: false,
      configuredMaxConcurrentRuns: 20,
      agentId: "agent-1",
      companyId: "company-1",
      createRunForWake: vi.fn(async () => "run-should-not-happen"),
    });

    expect(result).toEqual({ promoted: 0, runIds: [] });
    expect(writer.runnable).toHaveLength(1);
    expect(host.events).toHaveLength(0);
  });

  it("serializes two back-to-back assignments: park then promote one at a time", async () => {
    const writer = createMemoryWriter();
    const host = createFakeHost(0);
    const evaluate = createEvaluateAgentSchedulerAdmission({ host, writer });
    const promote = createPromoteAgentRunnableWork({ host, writer });

    const first = await evaluate({
      ...BASE_FACTS,
      runningRunCount: 0,
      wakeRequestId: "wake-1",
      issueId: "issue-1",
    });
    expect(first).toEqual({ action: "materialize" });

    host.setRunningCount(1);
    const second = await evaluate({
      ...BASE_FACTS,
      runningRunCount: 1,
      wakeRequestId: "wake-2",
      issueId: "issue-2",
    });
    expect(second).toEqual({ action: "park", queueDepth: 1 });

    host.setRunningCount(0);
    const afterFirstRun = await promote({
      schedulerEnabled: true,
      allowParallelExecution: false,
      configuredMaxConcurrentRuns: 20,
      agentId: "agent-1",
      companyId: "company-1",
      createRunForWake: async (wake) => `run-${wake.id}`,
    });
    expect(afterFirstRun.promoted).toBe(1);
    expect(writer.runnable).toHaveLength(0);
  });
});
