import { describe, expect, it } from "vitest";
import { createFoldSourceResolvedRun } from "./fold-source-resolved-run.js";
import { createScanSilentActiveRuns } from "./scan-silent-active-runs.js";
import type { RunProcessController, WatchdogRunReader, WatchdogWriter } from "./ports.js";
import type { RunSnapshot } from "./types.js";

const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;

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
    contextSnapshot: { issueId: "issue-1" },
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
    findRunningAgent: async () => ({ id: "agent-1", companyId: "company-1", adapterType: "codex_local" }),
    findEvaluationIssueById: async () => null,
    ...overrides,
  };
}

function makeFoldUseCase(writerOverrides: Partial<WatchdogWriter> = {}) {
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
    const run = makeRun();
    const reader = makeReader({
      findCandidateSilentRuns: async () => [run],
      findLatestDecision: async () => ({
        quietUntilDecision: { decision: "snooze", snoozedUntil: new Date("2026-01-01T06:00:00.000Z") },
        dismissedFalsePositive: false,
      }),
    });
    const scanSilentActiveRuns = createScanSilentActiveRuns({
      reader,
      foldSourceResolvedRun: makeFoldUseCase(),
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
      foldSourceResolvedRun: makeFoldUseCase(),
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
    const run = makeRun();
    const reader = makeReader({
      findCandidateSilentRuns: async () => [run],
      findRunningAgent: async () => ({ id: "agent-1", companyId: "other-company", adapterType: "codex_local" }),
    });
    const scanSilentActiveRuns = createScanSilentActiveRuns({
      reader,
      foldSourceResolvedRun: makeFoldUseCase(),
      suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
    });

    const result = await scanSilentActiveRuns({ now: new Date("2026-01-01T05:00:00.000Z") });

    expect(result).toMatchObject({ scanned: 1, skipped: 1 });
  });

  it("folds a run whose source issue has same-run terminal evidence", async () => {
    const run = makeRun();
    const reader = makeReader({
      findCandidateSilentRuns: async () => [run],
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
      foldSourceResolvedRun: makeFoldUseCase({
        foldSourceResolvedRun: async () => ({ kind: "folded", evaluationIssueId: null }),
      }),
      suspicionThresholdMs: SUSPICION_THRESHOLD_MS,
    });

    const result = await scanSilentActiveRuns({ now: new Date("2026-01-01T05:00:00.000Z") });

    expect(result).toMatchObject({ scanned: 1, folded: 1, skipped: 0 });
  });
});
