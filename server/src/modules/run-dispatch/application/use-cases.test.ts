import { describe, expect, it, vi } from "vitest";
import {
  createCancelStaleQueuedRun,
  createDispatchResolvedInteractionIfCurrent,
  createEvaluateScheduledRetryGate,
  createPromoteDueScheduledRetries,
  createPromoteScheduledRetry,
} from "./use-cases.js";
import { QUOTA_RECOVERY_RETRY_REASON } from "../domain/quota-recovery-release.js";
import type { DueRetryRun, RunDispatchWriter, ScheduledRetryReader } from "./ports.js";

const SWEEP_NOW = new Date("2026-01-01T00:00:00.000Z");

function fakeReader(
  dueRuns: DueRetryRun[] = [],
  inflight: ReadonlyMap<string, number> | null = new Map(),
): ScheduledRetryReader & { evaluateCalls: unknown[] } {
  const evaluateCalls: unknown[] = [];
  return {
    evaluateCalls,
    async evaluateScheduledRetryGate(input) {
      evaluateCalls.push(input);
      return { allowed: true };
    },
    async listDueRetries() {
      return dueRuns;
    },
    async countInflightQuotaRecoveryRetries() {
      if (inflight instanceof Error) throw inflight;
      return inflight;
    },
  };
}

/** A due retry row as the sweep reads it. */
function dueRetry(overrides: Partial<DueRetryRun> & { runId: string }): DueRetryRun {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    scheduledRetryAt: new Date("2026-01-01T00:00:00.000Z"),
    scheduledRetryReason: QUOTA_RECOVERY_RETRY_REASON,
    ...overrides,
  };
}

function fakeWriter(overrides: Partial<RunDispatchWriter> = {}): RunDispatchWriter & {
  promoteCalls: unknown[];
  deferCalls: unknown[];
  cancelCalls: unknown[];
  dispatchCalls: unknown[];
} {
  const promoteCalls: unknown[] = [];
  const deferCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  return {
    promoteCalls,
    deferCalls,
    cancelCalls,
    dispatchCalls,
    async promoteOrCancelDueRetry(input) {
      promoteCalls.push(input);
      return { outcome: "promoted", postCommitEffects: [] };
    },
    async deferScheduledRetry(input) {
      deferCalls.push(input);
      return { deferred: true };
    },
    async cancelStaleQueuedRun(input) {
      cancelCalls.push(input);
      return { outcome: "not_stale" };
    },
    async dispatchResolvedInteractionIfCurrent(input) {
      dispatchCalls.push(input);
      return { dispatched: true, resultPromise: input.dispatch(() => {}) };
    },
    ...overrides,
  };
}

describe("createEvaluateScheduledRetryGate", () => {
  it("maps identifiers and a default clock onto the semantic reader operation", async () => {
    const reader = fakeReader();
    const before = Date.now();
    const result = await createEvaluateScheduledRetryGate({ reader })({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });

    expect(result).toEqual({ allowed: true });
    expect(reader.evaluateCalls).toHaveLength(1);
    const call = reader.evaluateCalls[0] as { now: Date };
    expect(call).toMatchObject({
      runId: "run-1",
      companyId: "company-1",
      retryReasonOverride: "max_turns_continuation",
    });
    expect(call.now.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("createPromoteScheduledRetry", () => {
  it("passes only semantic identifiers and the clock to the atomic operation", async () => {
    const writer = fakeWriter();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
      now,
    });

    expect(result).toEqual({ outcome: "promoted", postCommitEffects: [] });
    expect(writer.promoteCalls).toEqual([{ runId: "run-1", companyId: "company-1", now }]);
  });

  it("passes a gate-suppressed outcome through without a persistence row", async () => {
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({
        outcome: "gate_suppressed" as const,
        reason: "agent paused",
        errorCode: "agent_not_invokable" as const,
      })),
    });
    const result = await createPromoteScheduledRetry({ writer })({
      runId: "run-1",
      companyId: "company-1",
    });
    expect(result).toEqual({
      outcome: "gate_suppressed",
      reason: "agent paused",
      errorCode: "agent_not_invokable",
    });
  });
});

describe("createPromoteDueScheduledRetries", () => {
  const sweep = (reader: ScheduledRetryReader, writer: RunDispatchWriter) =>
    createPromoteDueScheduledRetries({
      reader,
      promoteScheduledRetry: createPromoteScheduledRetry({ writer }),
      deferScheduledRetry: (input) => writer.deferScheduledRetry(input),
      now: () => SWEEP_NOW,
      planSeed: () => 1,
    });

  it("keeps due order and caps a sweep at 50 runs", async () => {
    const dueRuns = Array.from({ length: 75 }, (_, i) =>
      dueRetry({
        runId: `run-${i}`,
        // Distinct agents so the per-agent cap does not engage: this test is
        // about the 50-row sweep ceiling, not the release cap.
        agentId: `agent-${i}`,
      }),
    );
    const reader = fakeReader(dueRuns);
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    expect(result.promoted).toBe(50);
    expect(result.runIds).toEqual(dueRuns.slice(0, 50).map(({ runId }) => runId));
  });

  it("releases only the per-agent cap and pushes the rest to a later due time", async () => {
    const dueRuns = Array.from({ length: 6 }, (_, i) => dueRetry({ runId: `run-${i}` }));
    const reader = fakeReader(dueRuns);
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    expect(result.promoted).toBe(1);
    expect((writer.promoteCalls as unknown[]).length).toBe(1);
    // Every row is accounted for: five pushed forward, none dropped.
    expect((writer.deferCalls as { scheduledRetryAt: Date }[]).length).toBe(5);
    for (const call of writer.deferCalls as { scheduledRetryAt: Date }[]) {
      expect(call.scheduledRetryAt.getTime()).toBeGreaterThan(SWEEP_NOW.getTime());
    }
  });

  it("counts an already in-flight quota recovery against the cap", async () => {
    const reader = fakeReader([dueRetry({ runId: "run-1" })], new Map([["agent-1", 1]]));
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    expect(result.promoted).toBe(0);
    expect((writer.deferCalls as unknown[]).length).toBe(1);
  });

  it("promotes another mechanism's retry on its existing path, without a cap slot", async () => {
    const reader = fakeReader([
      dueRetry({ runId: "run-quota" }),
      dueRetry({ runId: "run-process-loss", scheduledRetryReason: "process_loss" }),
    ]);
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    expect(result.promoted).toBe(2);
    expect((writer.deferCalls as unknown[]).length).toBe(0);
  });

  it("denies quota-recovery releases when the in-flight count cannot be read, and keeps other mechanisms moving", async () => {
    const reader = fakeReader(
      [
        dueRetry({ runId: "run-quota-1" }),
        dueRetry({ runId: "run-quota-2" }),
        dueRetry({ runId: "run-process-loss", scheduledRetryReason: "process_loss" }),
      ],
      new Error("connection reset") as unknown as ReadonlyMap<string, number>,
    );
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    expect(result.releasePlan.degraded).toBe(true);
    expect(result.runIds).toEqual(["run-process-loss"]);
    // A denied retry is left parked on its own due time, not rescheduled onto
    // a fabricated one, so a later sweep re-decides it.
    expect((writer.deferCalls as unknown[]).length).toBe(0);
  });

  it("releases every agent's slot in the same sweep, not just the first", async () => {
    const reader = fakeReader([
      dueRetry({ runId: "run-a1", agentId: "agent-1" }),
      dueRetry({ runId: "run-a2", agentId: "agent-1" }),
      dueRetry({ runId: "run-b1", agentId: "agent-2" }),
      dueRetry({ runId: "run-c1", agentId: "agent-3" }),
    ]);
    const writer = fakeWriter();
    const result = await sweep(reader, writer)({ cutoff: null, now: SWEEP_NOW });

    // Three agents, three slots. The cap is per agent, so it must not read as
    // a company-wide throttle.
    expect(result.promoted).toBe(3);
    expect((writer.deferCalls as unknown[]).length).toBe(1);
  });

  it("is reproducible for the same sweep instant and seed", async () => {
    const dueRuns = [
      dueRetry({ runId: "run-1", agentId: "agent-1" }),
      dueRetry({ runId: "run-2", agentId: "agent-1" }),
      dueRetry({ runId: "run-3", agentId: "agent-2" }),
    ];
    const first = fakeWriter();
    const second = fakeWriter();
    await sweep(fakeReader(dueRuns), first)({ cutoff: null, now: SWEEP_NOW });
    await sweep(fakeReader(dueRuns), second)({ cutoff: null, now: SWEEP_NOW });

    expect(second.deferCalls).toEqual(first.deferCalls);
    expect(second.promoteCalls).toEqual(first.promoteCalls);
  });
});

describe("createCancelStaleQueuedRun", () => {
  it("delegates the complete read-decide-cancel operation to the writer", async () => {
    const cancelStaleQueuedRun = vi.fn(async () => ({
      outcome: "cancelled" as const,
      reason: "issue reassigned",
      errorCode: "issue_assignee_changed" as const,
      postCommitEffects: [],
    }));
    const writer = fakeWriter({
      cancelStaleQueuedRun,
    });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createCancelStaleQueuedRun({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });

    expect(result.outcome).toBe("cancelled");
    expect(cancelStaleQueuedRun).toHaveBeenCalledWith({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "queued",
      now,
    });
  });
});

describe("createDispatchResolvedInteractionIfCurrent", () => {
  it("delegates the lock, validation, cancellation, and dispatch boundary", async () => {
    const writer = fakeWriter();
    const dispatch = vi.fn(async () => "started");
    const result = await createDispatchResolvedInteractionIfCurrent({ writer })({
      runId: "run-1",
      companyId: "company-1",
      expectedStatus: "running",
      dispatch,
    });

    expect(result.dispatched).toBe(true);
    expect(writer.dispatchCalls).toHaveLength(1);
  });
});
