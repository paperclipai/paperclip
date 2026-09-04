import { describe, expect, it } from "vitest";
import { createRecordWatchdogDecision } from "./record-watchdog-decision.js";
import type { WatchdogRunReader, WatchdogWriter } from "./ports.js";
import type { RunSnapshot } from "./types.js";

const CONTINUE_REARM_MS = 30 * 60 * 1000;

function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "running",
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    processStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    contextSnapshot: {},
    resultJson: null,
    wakeupRequestId: null,
    processPid: null,
    processGroupId: null,
    ...overrides,
  };
}

function makeReader(overrides: Partial<WatchdogRunReader> = {}): WatchdogRunReader {
  return {
    findCandidateSilentRuns: async () => [],
    findRunForCompany: async () => makeRun(),
    findLatestDecision: async () => ({ quietUntilDecision: null, dismissedFalsePositive: false }),
    findOpenStaleRunEvaluation: async () => null,
    findLatestSameRunTerminalEvidence: async () => null,
    findSourceIssue: async () => null,
    findRunningAgent: async () => null,
    findEvaluationIssueById: async () => null,
    ...overrides,
  };
}

function makeWriter(overrides: Partial<WatchdogWriter> = {}): WatchdogWriter {
  return {
    recordDecision: async (companyId, input) => ({
      id: "decision-1",
      companyId,
      runId: input.runId,
      evaluationIssueId: input.evaluationIssueId,
      decision: input.decision,
      snoozedUntil: input.snoozedUntil,
      reason: input.reason,
      createdByAgentId: input.createdByAgentId,
      createdByUserId: input.createdByUserId,
      createdByRunId: input.createdByRunId,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
    foldSourceResolvedRun: async () => {
      throw new Error("not used in this test");
    },
    ...overrides,
  };
}

describe("createRecordWatchdogDecision", () => {
  it("records snooze, continue, and false-positive decisions with company scope", async () => {
    const now = new Date("2026-01-01T05:00:00.000Z");
    const snoozedUntil = new Date("2026-01-01T06:00:00.000Z");
    const recordWatchdogDecision = createRecordWatchdogDecision({
      reader: makeReader(),
      writer: makeWriter(),
      continueRearmMs: CONTINUE_REARM_MS,
    });

    const snooze = await recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "board" },
      decision: "snooze",
      snoozedUntil,
      now,
    });
    expect(snooze).toMatchObject({ companyId: "company-1", runId: "run-1", decision: "snooze", snoozedUntil });

    const continueDecision = await recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "board" },
      decision: "continue",
      now,
    });
    expect(continueDecision.snoozedUntil?.toISOString()).toBe(new Date(now.getTime() + CONTINUE_REARM_MS).toISOString());

    const dismissed = await recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "board" },
      decision: "dismissed_false_positive",
      now,
    });
    expect(dismissed).toMatchObject({ decision: "dismissed_false_positive", snoozedUntil: null });
  });

  it("rejects an agent decision with no target evaluation issue", async () => {
    const recordWatchdogDecision = createRecordWatchdogDecision({
      reader: makeReader(),
      writer: makeWriter(),
      continueRearmMs: CONTINUE_REARM_MS,
    });

    await expect(recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "agent", agentId: "agent-9" },
      decision: "continue",
      now: new Date("2026-01-01T05:00:00.000Z"),
    })).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an agent decision when the agent is not the evaluation issue's assignee", async () => {
    const reader = makeReader({
      findEvaluationIssueById: async () => ({
        id: "eval-1",
        identifier: "PAP-2",
        status: "todo",
        assigneeAgentId: "agent-1",
        companyId: "company-1",
        originKind: "stale_active_run_evaluation",
        originId: "run-1",
        hiddenAt: null,
      }),
    });
    const recordWatchdogDecision = createRecordWatchdogDecision({
      reader,
      writer: makeWriter(),
      continueRearmMs: CONTINUE_REARM_MS,
    });

    await expect(recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "agent", agentId: "agent-9" },
      decision: "continue",
      evaluationIssueId: "eval-1",
      now: new Date("2026-01-01T05:00:00.000Z"),
    })).rejects.toMatchObject({ status: 403 });
  });

  it("accepts an agent decision when the agent is the assigned recovery owner", async () => {
    const reader = makeReader({
      findEvaluationIssueById: async () => ({
        id: "eval-1",
        identifier: "PAP-2",
        status: "todo",
        assigneeAgentId: "agent-1",
        companyId: "company-1",
        originKind: "stale_active_run_evaluation",
        originId: "run-1",
        hiddenAt: null,
      }),
    });
    const recordWatchdogDecision = createRecordWatchdogDecision({
      reader,
      writer: makeWriter(),
      continueRearmMs: CONTINUE_REARM_MS,
    });

    const decision = await recordWatchdogDecision({
      companyId: "company-1",
      runId: "run-1",
      actor: { type: "agent", agentId: "agent-1" },
      decision: "continue",
      evaluationIssueId: "eval-1",
      now: new Date("2026-01-01T05:00:00.000Z"),
    });

    expect(decision).toMatchObject({ evaluationIssueId: "eval-1", createdByAgentId: "agent-1" });
  });

  it("throws not found when the run does not exist in the company", async () => {
    const recordWatchdogDecision = createRecordWatchdogDecision({
      reader: makeReader({ findRunForCompany: async () => null }),
      writer: makeWriter(),
      continueRearmMs: CONTINUE_REARM_MS,
    });

    await expect(recordWatchdogDecision({
      companyId: "company-1",
      runId: "missing-run",
      actor: { type: "board" },
      decision: "snooze",
      snoozedUntil: new Date("2026-01-01T06:00:00.000Z"),
      now: new Date("2026-01-01T05:00:00.000Z"),
    })).rejects.toMatchObject({ status: 404 });
  });
});
