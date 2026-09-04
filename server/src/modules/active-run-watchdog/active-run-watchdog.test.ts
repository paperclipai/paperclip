import { beforeEach, describe, expect, it, vi } from "vitest";
import { runningProcesses } from "../../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../services/local-service-supervisor.js";
import { createProcessAdapter } from "./adapters/process.js";
import {
  createBuildRunOutputSilence,
  createFoldSourceResolvedRun,
  createRecordWatchdogDecision,
  createScanSilentActiveRuns,
} from "./application/use-cases.js";
import type { RunProcessController, WatchdogRunReader, WatchdogWriter } from "./application/ports.js";
import type { RunSnapshot } from "./application/types.js";
import {
  classifySilenceLevel,
  evaluateSuppression,
  isTerminalIssueStatus,
  shouldFoldTerminalSource,
  silenceAgeMs,
  silenceStartedAt,
} from "./domain/policy.js";

vi.mock("../../services/local-service-supervisor.js", () => ({
  isPidAlive: vi.fn(),
  isProcessGroupAlive: vi.fn(),
  terminateLocalService: vi.fn(),
}));

const mockedIsPidAlive = vi.mocked(isPidAlive);
const mockedIsProcessGroupAlive = vi.mocked(isProcessGroupAlive);
const mockedTerminateLocalService = vi.mocked(terminateLocalService);

describe("domain", () => {
  const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
  const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

  describe("silenceStartedAt / silenceAgeMs", () => {
    it.each([
      {
        name: "prefers the last output time over every other timestamp",
        run: {
          lastOutputAt: new Date("2026-01-01T00:10:00.000Z"),
          processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:10:00.000Z",
      },
      {
        name: "falls back to the process start time when there is no output",
        run: {
          lastOutputAt: null,
          processStartedAt: new Date("2026-01-01T00:05:00.000Z"),
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:05:00.000Z",
      },
      {
        name: "falls back to the run start time when there is no process start",
        run: {
          lastOutputAt: null,
          processStartedAt: null,
          startedAt: new Date("2026-01-01T00:04:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:04:00.000Z",
      },
      {
        name: "falls back to the run creation time last",
        run: {
          lastOutputAt: null,
          processStartedAt: null,
          startedAt: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        expected: "2026-01-01T00:00:00.000Z",
      },
    ])("selects the latest usable timestamp: $name", ({ run, expected }) => {
      expect(silenceStartedAt(run)?.toISOString()).toBe(expected);
    });

    it("returns null when every timestamp is null", () => {
      expect(silenceStartedAt({ lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null })).toBeNull();
    });

    it("calculates the silence age from the selected timestamp", () => {
      const run = {
        lastOutputAt: new Date("2026-01-01T00:00:00.000Z"),
        processStartedAt: null,
        startedAt: null,
        createdAt: null,
      };
      const now = new Date("2026-01-01T01:00:00.000Z");

      expect(silenceAgeMs(run, now)).toBe(60 * 60 * 1000);
    });

    it("floors the silence age at zero when the clock reads before the start", () => {
      const run = {
        lastOutputAt: new Date("2026-01-01T01:00:00.000Z"),
        processStartedAt: null,
        startedAt: null,
        createdAt: null,
      };
      const now = new Date("2026-01-01T00:00:00.000Z");

      expect(silenceAgeMs(run, now)).toBe(0);
    });

    it("returns null silence age when there is no usable timestamp", () => {
      const run = { lastOutputAt: null, processStartedAt: null, startedAt: null, createdAt: null };

      expect(silenceAgeMs(run, new Date("2026-01-01T00:00:00.000Z"))).toBeNull();
    });
  });

  describe("classifySilenceLevel", () => {
    function classifyInput(overrides: {
      isRunningRun?: boolean;
      silenceAgeMs?: number | null;
      dismissedFalsePositive?: boolean;
      snoozed?: boolean;
    } = {}) {
      return {
        isRunningRun: true,
        silenceAgeMs: null,
        dismissedFalsePositive: false,
        snoozed: false,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
        ...overrides,
      };
    }

    it.each([
      {
        name: "not-applicable when the run is not running",
        input: classifyInput({ isRunningRun: false, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "not_applicable",
      },
      {
        name: "not-applicable when the run has a permanent false-positive dismissal",
        input: classifyInput({ dismissedFalsePositive: true, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "not_applicable",
      },
      {
        name: "snoozed when a snooze or continue decision is active",
        input: classifyInput({ snoozed: true, silenceAgeMs: CRITICAL_THRESHOLD_MS + 1 }),
        expected: "snoozed",
      },
      {
        name: "healthy below the suspicion threshold",
        input: classifyInput({ silenceAgeMs: SUSPICION_THRESHOLD_MS - 1 }),
        expected: "ok",
      },
      {
        name: "suspicious at or above the suspicion threshold",
        input: classifyInput({ silenceAgeMs: SUSPICION_THRESHOLD_MS }),
        expected: "suspicious",
      },
      {
        name: "critical at or above the critical threshold",
        input: classifyInput({ silenceAgeMs: CRITICAL_THRESHOLD_MS }),
        expected: "critical",
      },
      {
        name: "healthy when there is no silence age yet",
        input: classifyInput(),
        expected: "ok",
      },
    ])("classifies: $name", ({ input, expected }) => {
      expect(classifySilenceLevel(input)).toBe(expected);
    });
  });

  describe("evaluateSuppression", () => {
    it("suppresses a snoozed run until the snooze expires", () => {
      expect(evaluateSuppression({ snoozedOrContinued: true })).toEqual({
        suppressed: true,
        reason: "snoozed",
      });
    });

    it("re-arms the watchdog once the continue decision's snooze window has passed", () => {
      expect(evaluateSuppression({ snoozedOrContinued: false })).toEqual({ suppressed: false });
    });

    it("suppresses a run permanently after a false-positive decision", () => {
      expect(evaluateSuppression({ dismissedFalsePositive: true })).toEqual({
        suppressed: true,
        reason: "dismissed_false_positive",
      });
    });

    it("suppresses a blocked source", () => {
      expect(evaluateSuppression({ blockedSource: true })).toEqual({
        suppressed: true,
        reason: "blocked_source",
      });
    });

    it("suppresses a recovery-origin source", () => {
      expect(evaluateSuppression({ recoveryOriginSource: true })).toEqual({
        suppressed: true,
        reason: "recovery_origin_source",
      });
    });

    it("is not suppressed when no signal is set", () => {
      expect(evaluateSuppression({})).toEqual({ suppressed: false });
    });

    it("checks snoozed before recovery-origin, blocked-source, and dismissed-false-positive", () => {
      expect(
        evaluateSuppression({
          snoozedOrContinued: true,
          recoveryOriginSource: true,
          blockedSource: true,
          dismissedFalsePositive: true,
        }),
      ).toEqual({ suppressed: true, reason: "snoozed" });
    });
  });

  describe("isTerminalIssueStatus", () => {
    it.each([
      { status: "done", expected: true },
      { status: "cancelled", expected: true },
      { status: "in_progress", expected: false },
      { status: "blocked", expected: false },
      { status: null, expected: false },
      { status: undefined, expected: false },
    ])("$status -> $expected", ({ status, expected }) => {
      expect(isTerminalIssueStatus(status)).toBe(expected);
    });
  });

  describe("shouldFoldTerminalSource", () => {
    it("folds a terminal source only with same-run terminal evidence", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: true }),
      ).toBe(true);
    });

    it("does not fold a terminal source without same-run terminal evidence", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "done", hasSameRunTerminalEvidence: false }),
      ).toBe(false);
    });

    it("does not fold a non-terminal source even with evidence present", () => {
      expect(
        shouldFoldTerminalSource({ sourceIssueStatus: "in_progress", hasSameRunTerminalEvidence: true }),
      ).toBe(false);
    });
  });
});

describe("application", () => {
  const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
  const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
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
      findRunForCompany: async () => null,
      findLatestDecision: async () => ({ quietUntilDecision: null, dismissedFalsePositive: false }),
      findOpenStaleRunEvaluation: async () => null,
      findLatestSameRunTerminalEvidence: async () => null,
      findSourceIssue: async () => null,
      findRunningAgent: async () => null,
      findEvaluationIssueById: async () => null,
      ...overrides,
    };
  }

  describe("createBuildRunOutputSilence", () => {
    it("builds a summary from the reader ports and the domain level", async () => {
      const now = new Date("2026-01-01T05:00:00.000Z");
      const run = makeRun();
      const reader = makeReader({
        findOpenStaleRunEvaluation: async () => ({
          id: "eval-1",
          identifier: "PAP-9",
          status: "todo",
          assigneeAgentId: "agent-2",
          companyId: "company-1",
          originKind: "stale_active_run_evaluation",
          originId: run.id,
          hiddenAt: null,
        }),
      });
      const buildRunOutputSilence = createBuildRunOutputSilence({
        reader,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      });

      const summary = await buildRunOutputSilence(run, now);

      expect(summary).toMatchObject({
        level: "critical",
        silenceAgeMs: 5 * 60 * 60 * 1000,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
        evaluationIssueId: "eval-1",
        evaluationIssueIdentifier: "PAP-9",
        evaluationIssueAssigneeAgentId: "agent-2",
      });
    });

    it("reports snoozed while a snooze decision is active", async () => {
      const now = new Date("2026-01-01T05:00:00.000Z");
      const run = makeRun();
      const snoozedUntil = new Date("2026-01-01T06:00:00.000Z");
      const reader = makeReader({
        findLatestDecision: async () => ({
          quietUntilDecision: { decision: "snooze", snoozedUntil },
          dismissedFalsePositive: false,
        }),
      });
      const buildRunOutputSilence = createBuildRunOutputSilence({
        reader,
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      });

      const summary = await buildRunOutputSilence(run, now);

      expect(summary).toMatchObject({ level: "snoozed", snoozedUntil });
    });

    it("reports not_applicable for a run that is not running", async () => {
      const now = new Date("2026-01-01T05:00:00.000Z");
      const run = makeRun({ status: "succeeded" });
      const buildRunOutputSilence = createBuildRunOutputSilence({
        reader: makeReader(),
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
        criticalThresholdMs: CRITICAL_THRESHOLD_MS,
      });

      const summary = await buildRunOutputSilence(run, now);

      expect(summary).toMatchObject({ level: "not_applicable", silenceAgeMs: null });
    });
  });

  const foldSourceIssue = {
    id: "issue-1",
    identifier: "PAP-1",
    status: "done",
    originKind: "manual",
    isRecoveryOriginKind: false,
  };
  const foldEvidence = {
    kind: "activity" as const,
    id: "activity-1",
    createdAt: new Date("2026-01-01T00:10:00.000Z"),
    action: "issue.updated",
  };

  describe("createFoldSourceResolvedRun", () => {
    it("cleans up the process before the folding persistence call", async () => {
      const calls: string[] = [];
      const processController: RunProcessController = {
        cleanupRunProcess: async (input) => {
          calls.push("cleanup");
          expect(input).toMatchObject({ runId: "run-1", adapterType: "codex_local", fallbackPid: 4242 });
          return { attempted: true, outcome: "terminated", adapterType: "codex_local", pid: 4242, processGroupId: null };
        },
      };
      const writer: WatchdogWriter = {
        recordDecision: async () => {
          throw new Error("not used in this test");
        },
        foldSourceResolvedRun: async (companyId, input) => {
          calls.push("fold");
          expect(companyId).toBe("company-1");
          expect(input.cleanup).toMatchObject({ outcome: "terminated" });
          return { kind: "folded", evaluationIssueId: null };
        },
      };
      const foldSourceResolvedRun = createFoldSourceResolvedRun({ writer, processController });

      const outcome = await foldSourceResolvedRun({
        run: makeRun({ processPid: 4242 }),
        runningAgentAdapterType: "codex_local",
        sourceIssue: foldSourceIssue,
        evidence: foldEvidence,
        existingEvaluation: null,
        silenceStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        silenceAgeMs: 5 * 60 * 60 * 1000,
        now: new Date("2026-01-01T05:00:00.000Z"),
      });

      expect(calls).toEqual(["cleanup", "fold"]);
      expect(outcome).toEqual({ kind: "folded", evaluationIssueId: null });
    });

    it("returns a stale outcome when the compare-and-set fails after termination", async () => {
      const processController: RunProcessController = {
        cleanupRunProcess: async () => ({
          attempted: true,
          outcome: "terminated",
          adapterType: "codex_local",
          pid: 4242,
          processGroupId: null,
        }),
      };
      const writer: WatchdogWriter = {
        recordDecision: async () => {
          throw new Error("not used in this test");
        },
        foldSourceResolvedRun: async () => ({ kind: "stale" }),
      };
      const foldSourceResolvedRun = createFoldSourceResolvedRun({ writer, processController });

      const outcome = await foldSourceResolvedRun({
        run: makeRun({ processPid: 4242 }),
        runningAgentAdapterType: "codex_local",
        sourceIssue: foldSourceIssue,
        evidence: foldEvidence,
        existingEvaluation: null,
        silenceStartedAt: null,
        silenceAgeMs: null,
        now: new Date("2026-01-01T05:00:00.000Z"),
      });

      expect(outcome).toEqual({ kind: "stale" });
    });
  });

  function makeDecisionWriter(overrides: Partial<WatchdogWriter> = {}): WatchdogWriter {
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
        reader: makeReader({ findRunForCompany: async () => makeRun() }),
        writer: makeDecisionWriter(),
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
        reader: makeReader({ findRunForCompany: async () => makeRun() }),
        writer: makeDecisionWriter(),
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
        findRunForCompany: async () => makeRun(),
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
        writer: makeDecisionWriter(),
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
        findRunForCompany: async () => makeRun(),
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
        writer: makeDecisionWriter(),
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
        writer: makeDecisionWriter(),
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

  function makeScanFoldUseCase(writerOverrides: Partial<WatchdogWriter> = {}) {
    const processController: RunProcessController = {
      cleanupRunProcess: async () => ({
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: "codex_local",
      }),
    };
    const writer: WatchdogWriter = {
      recordDecision: async () => {
        throw new Error("not used in this test");
      },
      foldSourceResolvedRun: async () => ({ kind: "folded", evaluationIssueId: null }),
      ...writerOverrides,
    };
    return createFoldSourceResolvedRun({ writer, processController });
  }

  describe("createScanSilentActiveRuns", () => {
    it("skips suppressed runs and keeps the created and escalated counters at zero", async () => {
      const run = makeRun({ contextSnapshot: { issueId: "issue-1" } });
      const reader = makeReader({
        findCandidateSilentRuns: async () => [run],
        findLatestDecision: async () => ({
          quietUntilDecision: { decision: "snooze", snoozedUntil: new Date("2026-01-01T06:00:00.000Z") },
          dismissedFalsePositive: false,
        }),
      });
      const scanSilentActiveRuns = createScanSilentActiveRuns({
        reader,
        foldSourceResolvedRun: makeScanFoldUseCase(),
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
      });

      const result = await scanSilentActiveRuns({ now: new Date("2026-01-01T05:00:00.000Z") });

      expect(result).toMatchObject({ scanned: 1, snoozed: 1, created: 0, escalated: 0, skipped: 0 });
    });

    it("applies the optional company scope and the issue-date cutoff to the candidate query", async () => {
      let seenInput: unknown = null;
      const now = new Date("2026-01-01T05:00:00.000Z");
      const cutoff = new Date("2026-01-01T00:00:00.000Z");
      const reader = makeReader({
        findCandidateSilentRuns: async (input) => {
          seenInput = input;
          return [];
        },
      });
      const scanSilentActiveRuns = createScanSilentActiveRuns({
        reader,
        foldSourceResolvedRun: makeScanFoldUseCase(),
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
      });

      await scanSilentActiveRuns({ now, companyId: "company-9", issueCreatedAtGte: cutoff });

      expect(seenInput).toMatchObject({
        companyId: "company-9",
        suspicionBefore: new Date(now.getTime() - SUSPICION_THRESHOLD_MS),
        issueCreatedAtGte: cutoff,
      });
    });

    it("skips a run whose running agent belongs to a different company", async () => {
      const run = makeRun({ contextSnapshot: { issueId: "issue-1" } });
      const reader = makeReader({
        findCandidateSilentRuns: async () => [run],
        findRunningAgent: async () => ({ id: "agent-1", companyId: "other-company", adapterType: "codex_local" }),
      });
      const scanSilentActiveRuns = createScanSilentActiveRuns({
        reader,
        foldSourceResolvedRun: makeScanFoldUseCase(),
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
      });

      const result = await scanSilentActiveRuns({ now: new Date("2026-01-01T05:00:00.000Z") });

      expect(result).toMatchObject({ scanned: 1, skipped: 1 });
    });

    it("folds a run whose source issue has same-run terminal evidence", async () => {
      const run = makeRun({ contextSnapshot: { issueId: "issue-1" } });
      const reader = makeReader({
        findCandidateSilentRuns: async () => [run],
        findRunningAgent: async () => ({ id: "agent-1", companyId: "company-1", adapterType: "codex_local" }),
        findSourceIssue: async () => ({
          id: "issue-1",
          identifier: "PAP-1",
          status: "done",
          originKind: "manual",
          isRecoveryOriginKind: false,
        }),
        findLatestSameRunTerminalEvidence: async () => ({
          kind: "activity",
          id: "activity-1",
          createdAt: new Date("2026-01-01T00:10:00.000Z"),
          action: "issue.updated",
        }),
      });
      const scanSilentActiveRuns = createScanSilentActiveRuns({
        reader,
        foldSourceResolvedRun: makeScanFoldUseCase({
          foldSourceResolvedRun: async () => ({ kind: "folded", evaluationIssueId: null }),
        }),
        suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
      });

      const result = await scanSilentActiveRuns({ now: new Date("2026-01-01T05:00:00.000Z") });

      expect(result).toMatchObject({ scanned: 1, folded: 1, skipped: 0 });
    });
  });
});

describe("adapters", () => {
  describe("createProcessAdapter", () => {
    beforeEach(() => {
      mockedIsPidAlive.mockReset();
      mockedIsProcessGroupAlive.mockReset();
      mockedTerminateLocalService.mockReset();
      runningProcesses.clear();
    });

    it("reports skipped_non_local_adapter for a non-sessioned adapter type", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "hermes_gateway",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({ attempted: false, outcome: "skipped_non_local_adapter", adapterType: "hermes_gateway" });
      expect(mockedIsPidAlive).not.toHaveBeenCalled();
    });

    it("reports no_process_metadata when no pid or process group is known", async () => {
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: null,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({ attempted: false, outcome: "no_process_metadata", adapterType: "codex_local" });
    });

    it("reports not_running when the process is dead", async () => {
      mockedIsPidAlive.mockReturnValue(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: false,
        outcome: "not_running",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).not.toHaveBeenCalled();
    });

    it("reports terminated when the live process stops after termination", async () => {
      mockedIsPidAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "terminated",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
      });
      expect(mockedTerminateLocalService).toHaveBeenCalledTimes(1);
    });

    it("reports failed when termination throws", async () => {
      mockedIsPidAlive.mockReturnValue(true);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockRejectedValue(new Error("kill failed"));
      const adapter = createProcessAdapter();

      const outcome = await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid: 4242,
        fallbackProcessGroupId: null,
      });

      expect(outcome).toEqual({
        attempted: true,
        outcome: "failed",
        adapterType: "codex_local",
        pid: 4242,
        processGroupId: null,
        error: "kill failed",
      });
    });

    it.each([
      { fallbackPid: 0 },
      { fallbackPid: -7 },
      { fallbackPid: 4.5 },
    ])("returns a typed no-op for an invalid process identifier ($fallbackPid)", async ({ fallbackPid }) => {
      mockedIsPidAlive.mockReturnValue(true);
      mockedIsProcessGroupAlive.mockReturnValue(false);
      mockedTerminateLocalService.mockResolvedValue(undefined);
      const adapter = createProcessAdapter();

      await adapter.cleanupRunProcess({
        runId: "run-1",
        adapterType: "codex_local",
        fallbackPid,
        fallbackProcessGroupId: null,
      });

      expect(mockedTerminateLocalService).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 0, processGroupId: null }),
        undefined,
      );
    });
  });
});
