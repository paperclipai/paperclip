import { describe, expect, it, vi } from "vitest";
import {
  createCancelStaleQueuedRun,
  createDispatchResolvedInteractionIfCurrent,
  createEvaluateScheduledRetryGate,
  createPromoteDueScheduledRetries,
  createPromoteEarlyUpstreamRecoveryRetries,
  createPromoteScheduledRetry,
} from "./use-cases.js";
import type {
  DueRetryRun,
  EarlyUpstreamReprobeCandidate,
  RunDispatchWriter,
  ScheduledRetryReader,
} from "./ports.js";
import type { UpstreamRecoveryEvidence } from "../domain/policy.js";

const REPROBE_NOW = new Date("2026-06-22T02:46:00.000Z");
/** Pinned to a weekly-quota reset 15h out, written before this sweep's clock. */
const FAR_FUTURE_PIN = new Date(REPROBE_NOW.getTime() + 15 * 60 * 60 * 1000);
const PIN_SET_AT = new Date(REPROBE_NOW.getTime() - 6 * 60_000);
const RECOVERY_EVIDENCE: UpstreamRecoveryEvidence = {
  runId: "green-run",
  finishedAt: new Date(REPROBE_NOW.getTime() - 60_000),
};

function reprobeCandidate(overrides: Partial<EarlyUpstreamReprobeCandidate> = {}) {
  return {
    runId: "pinned-run",
    companyId: "company-1",
    agentId: "agent-1",
    adapterType: "codex_local",
    retryReason: "transient_failure",
    scheduledRetryAt: FAR_FUTURE_PIN,
    pinSetAt: PIN_SET_AT,
    createdAt: PIN_SET_AT,
    ...overrides,
  } satisfies EarlyUpstreamReprobeCandidate;
}

function fakeReader(
  dueRuns: DueRetryRun[] = [],
  reprobe: {
    candidates?: EarlyUpstreamReprobeCandidate[];
    evidence?: UpstreamRecoveryEvidence | null;
    evidenceFor?: (input: { companyId: string; agentId: string; adapterType: string; now: Date }) => UpstreamRecoveryEvidence | null;
  } = {},
): ScheduledRetryReader & { evaluateCalls: unknown[]; evidenceCalls: unknown[] } {
  const evaluateCalls: unknown[] = [];
  const evidenceCalls: unknown[] = [];
  return {
    evaluateCalls,
    evidenceCalls,
    async evaluateScheduledRetryGate(input) {
      evaluateCalls.push(input);
      return { allowed: true };
    },
    async listDueRetries() {
      return dueRuns;
    },
    async listEarlyUpstreamReprobeCandidates(input) {
      const candidates = reprobe.candidates ?? [];
      const afterIndex = input.after
        ? candidates.findIndex((candidate) => candidate.runId === input.after?.runId) + 1
        : 0;
      return candidates.slice(afterIndex, afterIndex + input.limit);
    },
    async findUpstreamRecoveryEvidence(input) {
      evidenceCalls.push(input);
      return reprobe.evidenceFor ? reprobe.evidenceFor(input) : (reprobe.evidence ?? null);
    },
  };
}

function fakeWriter(overrides: Partial<RunDispatchWriter> = {}): RunDispatchWriter & {
  promoteCalls: unknown[];
  cancelCalls: unknown[];
  dispatchCalls: unknown[];
  advanceCalls: unknown[];
} {
  const promoteCalls: unknown[] = [];
  const cancelCalls: unknown[] = [];
  const dispatchCalls: unknown[] = [];
  const advanceCalls: unknown[] = [];
  return {
    promoteCalls,
    cancelCalls,
    dispatchCalls,
    advanceCalls,
    async promoteOrCancelDueRetry(input) {
      promoteCalls.push(input);
      return { outcome: "promoted", postCommitEffects: [] };
    },
    async advanceScheduledRetryPin(input) {
      advanceCalls.push(input);
      return { advanced: true };
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

function buildPromoters(
  reader: ScheduledRetryReader,
  writer: RunDispatchWriter,
) {
  const promoteScheduledRetry = createPromoteScheduledRetry({ writer });
  return createPromoteDueScheduledRetries({
    reader,
    promoteScheduledRetry,
    promoteEarlyUpstreamRecoveryRetries: createPromoteEarlyUpstreamRecoveryRetries({
      reader,
      writer,
      promoteScheduledRetry,
    }),
  });
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
  it("keeps due order and caps a sweep at 50 runs", async () => {
    const dueRuns = Array.from({ length: 75 }, (_, i) => ({
      runId: `run-${i}`,
      companyId: "company-1",
    }));
    const reader = fakeReader(dueRuns);
    const writer = fakeWriter();
    const result = await buildPromoters(reader, writer)({ cutoff: null });

    expect(result.promoted).toBe(50);
    expect(result.runIds).toEqual(dueRuns.slice(0, 50).map(({ runId }) => runId));
  });

  it("reports early re-probed runs in the same sweep as the due ones", async () => {
    const reader = fakeReader([{ runId: "due-run", companyId: "company-1" }], {
      candidates: [reprobeCandidate()],
      evidence: RECOVERY_EVIDENCE,
    });
    const writer = fakeWriter();
    const result = await buildPromoters(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 2, runIds: ["due-run", "pinned-run"] });
    expect(writer.advanceCalls).toEqual([
      {
        runId: "pinned-run",
        companyId: "company-1",
        now: REPROBE_NOW,
        originalScheduledRetryAt: FAR_FUTURE_PIN,
        evidenceRunId: "green-run",
      },
    ]);
  });

  it("never re-probes a run the due path already promoted this sweep", async () => {
    const reader = fakeReader([{ runId: "pinned-run", companyId: "company-1" }], {
      candidates: [reprobeCandidate()],
      evidence: RECOVERY_EVIDENCE,
    });
    const writer = fakeWriter();
    const result = await buildPromoters(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 1, runIds: ["pinned-run"] });
    expect(writer.advanceCalls).toEqual([]);
  });
});

describe("createPromoteEarlyUpstreamRecoveryRetries", () => {
  function buildEarlyPromoter(reader: ScheduledRetryReader, writer: RunDispatchWriter) {
    return createPromoteEarlyUpstreamRecoveryRetries({
      reader,
      writer,
      promoteScheduledRetry: createPromoteScheduledRetry({ writer }),
    });
  }

  it("pulls a stale pin forward, then promotes through the normal retry path", async () => {
    const reader = fakeReader([], { candidates: [reprobeCandidate()], evidence: RECOVERY_EVIDENCE });
    const writer = fakeWriter();
    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 1, runIds: ["pinned-run"] });
    expect(writer.promoteCalls).toEqual([
      { runId: "pinned-run", companyId: "company-1", now: REPROBE_NOW },
    ]);
  });

  it("holds the pin while the upstream is still down", async () => {
    const reader = fakeReader([], { candidates: [reprobeCandidate()], evidence: null });
    const writer = fakeWriter();
    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 0, runIds: [] });
    expect(writer.advanceCalls).toEqual([]);
    expect(writer.promoteCalls).toEqual([]);
  });

  it("leaves a run alone when another writer released its pin first", async () => {
    const reader = fakeReader([], { candidates: [reprobeCandidate()], evidence: RECOVERY_EVIDENCE });
    const writer = fakeWriter({
      advanceScheduledRetryPin: vi.fn(async () => ({ advanced: false as const })),
    });
    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 0, runIds: [] });
    expect(writer.promoteCalls).toEqual([]);
  });

  it("reads recovery evidence once per upstream scope per sweep", async () => {
    const reader = fakeReader([], {
      candidates: [
        reprobeCandidate({ runId: "pinned-1" }),
        reprobeCandidate({ runId: "pinned-2" }),
        reprobeCandidate({ runId: "pinned-3", companyId: "company-2" }),
      ],
      evidence: RECOVERY_EVIDENCE,
    });
    const writer = fakeWriter();
    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result.runIds).toEqual(["pinned-1", "pinned-2", "pinned-3"]);
    expect(reader.evidenceCalls).toEqual([
      { companyId: "company-1", agentId: "agent-1", adapterType: "codex_local", now: REPROBE_NOW },
      { companyId: "company-2", agentId: "agent-1", adapterType: "codex_local", now: REPROBE_NOW },
    ]);
  });

  it("checks one page per sweep and reaches every candidate across sweeps", async () => {
    // One agent per candidate defeats the per-scope cache: every candidate costs one evidence read.
    const candidates = Array.from({ length: 120 }, (_, index) =>
      reprobeCandidate({ runId: `pinned-${index}`, agentId: `agent-${index}` }),
    );
    const reader = fakeReader([], {
      candidates,
      evidenceFor: ({ agentId }) => agentId === "agent-119" ? RECOVERY_EVIDENCE : null,
    });
    const writer = fakeWriter();
    const promote = buildEarlyPromoter(reader, writer);

    const evidenceReadsPerSweep: number[] = [];
    const promotedPerSweep: string[][] = [];
    for (let sweep = 0; sweep < 3; sweep += 1) {
      const readsBefore = reader.evidenceCalls.length;
      const result = await promote({ now: REPROBE_NOW, cutoff: null });
      evidenceReadsPerSweep.push(reader.evidenceCalls.length - readsBefore);
      promotedPerSweep.push(result.runIds);
    }

    expect(evidenceReadsPerSweep).toEqual([50, 50, 20]);
    expect(promotedPerSweep).toEqual([[], [], ["pinned-119"]]);
    expect(writer.advanceCalls).toHaveLength(1);
  });

  it("wraps back to the first page after a short page", async () => {
    const candidates = Array.from({ length: 60 }, (_, index) =>
      reprobeCandidate({ runId: `pinned-${index}`, agentId: `agent-${index}` }),
    );
    const reader = fakeReader([], { candidates, evidence: null });
    const listCandidates = vi.spyOn(reader, "listEarlyUpstreamReprobeCandidates");
    const promote = buildEarlyPromoter(reader, fakeWriter());

    for (let sweep = 0; sweep < 3; sweep += 1) {
      await promote({ now: REPROBE_NOW, cutoff: null });
    }

    expect(listCandidates.mock.calls.map(([input]) => input.after?.runId ?? null)).toEqual([
      null,
      "pinned-49",
      null,
    ]);
  });

  it("moves past a page whose processing throws", async () => {
    const candidates = Array.from({ length: 51 }, (_, index) =>
      reprobeCandidate({ runId: `pinned-${index}`, agentId: `agent-${index}` }),
    );
    const reader = fakeReader([], {
      candidates,
      evidenceFor: ({ agentId }) => {
        if (agentId === "agent-0") throw new Error("evidence read failed");
        return agentId === "agent-50" ? RECOVERY_EVIDENCE : null;
      },
    });
    const promote = buildEarlyPromoter(reader, fakeWriter());

    await expect(promote({ now: REPROBE_NOW, cutoff: null })).rejects.toThrow("evidence read failed");
    const result = await promote({ now: REPROBE_NOW, cutoff: null });

    expect(result.runIds).toEqual(["pinned-50"]);
  });

  it("keeps a retry pinned when the predecessor's adapter is unknown", async () => {
    const reader = fakeReader([], {
      candidates: [reprobeCandidate({ adapterType: null })],
      evidence: RECOVERY_EVIDENCE,
    });
    const writer = fakeWriter();

    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result.promoted).toBe(0);
    expect(reader.evidenceCalls).toEqual([]);
    expect(writer.advanceCalls).toEqual([]);
  });

  it("does not promote a candidate whose gate suppressed it after the pin moved", async () => {
    const reader = fakeReader([], { candidates: [reprobeCandidate()], evidence: RECOVERY_EVIDENCE });
    const writer = fakeWriter({
      promoteOrCancelDueRetry: vi.fn(async () => ({
        outcome: "gate_suppressed" as const,
        reason: "issue reassigned",
        errorCode: "issue_reassigned" as const,
      })),
    });
    const result = await buildEarlyPromoter(reader, writer)({ now: REPROBE_NOW, cutoff: null });

    expect(result).toMatchObject({ promoted: 0, runIds: [], postCommitEffects: [] });
    expect(writer.advanceCalls).toHaveLength(1);
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
