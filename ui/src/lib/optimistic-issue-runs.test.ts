import { describe, expect, it } from "vitest";
import type { RunForIssue } from "../api/activity";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";
import { removeLiveRunById, upsertInterruptedRun } from "./optimistic-issue-runs";

function createLiveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "manual",
    triggerDetail: null,
    startedAt: "2026-04-08T21:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-04-08T21:00:00.000Z",
    agentId: "agent-1",
    agentName: "CodexCoder",
    adapterType: "codex_local",
    ...overrides,
  };
}

function createActiveRun(overrides: Partial<ActiveRunForIssue> = {}): ActiveRunForIssue {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    agentName: "CodexCoder",
    adapterType: "codex_local",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: "running",
    startedAt: new Date("2026-04-08T21:00:00.000Z"),
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: { inputTokens: 1 },
    resultJson: { summary: "partial" },
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-04-08T21:00:00.000Z"),
    updatedAt: new Date("2026-04-08T21:00:00.000Z"),
    ...overrides,
  };
}

describe("upsertInterruptedRun", () => {
  it("adds a synthetic cancelled historical run when the live run has not reached linkedRuns yet", () => {
    const runs = upsertInterruptedRun(undefined, createLiveRun(), "2026-04-08T21:00:10.000Z");
    expect(runs).toEqual([{
      runId: "run-1",
      status: "cancelled",
      agentId: "agent-1",
      adapterType: "codex_local",
      startedAt: "2026-04-08T21:00:00.000Z",
      finishedAt: "2026-04-08T21:00:10.000Z",
      createdAt: "2026-04-08T21:00:00.000Z",
      invocationSource: "manual",
      usageJson: null,
      resultJson: null,
    }]);
  });

  it("updates an existing linked run in place when the interrupted run is already present", () => {
    const existing: RunForIssue[] = [{
      runId: "run-1",
      status: "running",
      agentId: "agent-1",
      adapterType: "codex_local",
      startedAt: "2026-04-08T21:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-08T21:00:00.000Z",
      invocationSource: "manual",
      usageJson: { inputTokens: 2 },
      resultJson: { summary: "partial" },
    }];

    const runs = upsertInterruptedRun(existing, createActiveRun(), "2026-04-08T21:00:11.000Z");
    expect(runs).toEqual([{
      runId: "run-1",
      status: "cancelled",
      agentId: "agent-1",
      adapterType: "codex_local",
      startedAt: "2026-04-08T21:00:00.000Z",
      finishedAt: "2026-04-08T21:00:11.000Z",
      createdAt: "2026-04-08T21:00:00.000Z",
      invocationSource: "on_demand",
      usageJson: { inputTokens: 2 },
      resultJson: { summary: "partial" },
    }]);
  });
});

describe("removeLiveRunById", () => {
  it("removes an interrupted live run from the live list", () => {
    const runs = removeLiveRunById([
      createLiveRun(),
      createLiveRun({ id: "run-2" }),
    ], "run-1");
    expect(runs?.map((run) => run.id)).toEqual(["run-2"]);
  });
});
