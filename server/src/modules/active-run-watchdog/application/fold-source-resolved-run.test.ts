import { describe, expect, it } from "vitest";
import { createFoldSourceResolvedRun } from "./fold-source-resolved-run.js";
import type { RunProcessController, WatchdogWriter } from "./ports.js";
import type { RunSnapshot } from "./types.js";

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
    processPid: 4242,
    processGroupId: null,
    ...overrides,
  };
}

const sourceIssue = {
  id: "issue-1",
  identifier: "PAP-1",
  status: "done",
  originKind: "manual",
  isRecoveryOriginKind: false,
};
const evidence = { kind: "activity" as const, id: "activity-1", createdAt: new Date("2026-01-01T00:10:00.000Z"), action: "issue.updated" };

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
      run: makeRun(),
      runningAgentAdapterType: "codex_local",
      sourceIssue,
      evidence,
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
      run: makeRun(),
      runningAgentAdapterType: "codex_local",
      sourceIssue,
      evidence,
      existingEvaluation: null,
      silenceStartedAt: null,
      silenceAgeMs: null,
      now: new Date("2026-01-01T05:00:00.000Z"),
    });

    expect(outcome).toEqual({ kind: "stale" });
  });
});
