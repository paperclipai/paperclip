import { describe, expect, it } from "vitest";
import { createBuildRunOutputSilence } from "./build-run-output-silence.js";
import type { WatchdogRunReader } from "./ports.js";
import type { RunSnapshot } from "./types.js";

const SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
const CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;

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
