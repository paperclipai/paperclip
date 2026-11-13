import { describe, expect, it } from "vitest";
import { withChildWaits } from "./child-wait.js";
import { gradeTask } from "./grader.js";
import type { WakeEvidenceFile } from "./staging-mix-retry.js";
import type { RunSample, TaskRecord, TaskSample } from "./types.js";

const T0 = Date.parse("2026-11-13T05:37:21Z");
const SEC = 1_000;
const iso = (offset: number) => new Date(T0 + offset).toISOString();

const run = (id: string, status: string, started: number, finished: number | null): RunSample => ({ id, status, createdAt: iso(started), startedAt: iso(started),
  finishedAt: finished === null ? null : iso(finished), errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null,
  lastEvidenceAt: status === "running" ? iso(started) : null });
const sample = (at: number, runs: RunSample[], issueStatus = "in_progress"): TaskSample => ({ at: T0 + at, reachable: true, serverReady: true, issueStatus,
  interruption: null, activeRecoveryAction: false, executionBlocker: false, scheduledRetry: false, runs });

function parentRestedWaitingOnSubtasks(): TaskRecord {
  const samples: TaskSample[] = [];
  for (let at = 0; at < 2_000 * SEC; at += 10 * SEC) samples.push(sample(at, [{ ...run("r1", "running", 0, null), lastEvidenceAt: iso(at) }]));
  for (let at = 2_010 * SEC; at <= 2_210 * SEC; at += 10 * SEC) samples.push(sample(at, [run("r1", "succeeded", 0, 2_000 * SEC)]));
  return { plan: { taskId: "t001", index: 0, workload: "SM", adapter: "opencode", fault: "K13", fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce: "90a3899c" },
    issueId: "issue-1", identifier: "CHA-1", createdAt: T0, launchError: null, samples, retry: null, restAt: T0 + 2_010 * SEC, finalStatus: "in_progress",
    deadlineAt: T0 + 7_200 * SEC, timedOut: false, followUp: null, faultIds: [], sweep: { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null },
    preFaultFiles: null, lostFiles: null };
}

const evidence = (withChildCompletion: boolean): WakeEvidenceFile => ({
  completedAt: T0 + 2_871 * SEC,
  runs: [{ runId: "r1", createdAt: T0, startedAt: T0, finishedAt: T0 + 2_000 * SEC, invocationSource: "assignment", triggerDetail: "system", wakeupRequestId: "w1",
    acceptedDisposition: "yielded", acceptedAt: T0 + 1_999 * SEC },
  ...(withChildCompletion ? [{ runId: "r3", createdAt: T0 + 2_667 * SEC, startedAt: T0 + 2_820 * SEC, finishedAt: T0 + 2_871 * SEC, invocationSource: "automation",
    triggerDetail: "system", wakeupRequestId: "w3", acceptedDisposition: "done", acceptedAt: T0 + 2_870 * SEC }] : [])],
  wakes: [{ id: "w1", reason: "issue_assigned", source: "assignment", triggerDetail: "system", requestedByActorType: "user", requestedByActorId: "local-board", createdAt: T0 },
    ...(withChildCompletion ? [{ id: "w3", reason: "issue_children_completed", source: "automation", triggerDetail: "system", requestedByActorType: "agent",
      requestedByActorId: "a1", createdAt: T0 + 2_648 * SEC }] : [])],
});

const pass = { verdict: "pass" as const, checks: [] };

describe("a parent waiting on its subtasks (w-20261113T052703-s7301 t001)", () => {
  it("is a named wait, and the parent completed by its children-completed wake rests done", () => {
    const before = gradeTask(parentRestedWaitingOnSubtasks(), [], 4_345 * SEC, pass);
    expect([before.rules.R1.detail, before.rules.R3.verdict, before.rules.R5.verdict, before.universal!.U1.verdict])
      .toEqual(["rested_not_done (status in_progress, no Retry offered)", "fail", "fail", "fail"]);
    const record = withChildWaits(parentRestedWaitingOnSubtasks(), evidence(true));
    expect(record).toMatchObject({ finalStatus: "done", restAt: T0 + 2_871 * SEC });
    expect(record.samples.filter(entry => entry.waitingOnChildren).length).toBe(21);
    const after = gradeTask(record, [], 4_345 * SEC, pass);
    expect([after.rules.R1.verdict, after.rules.R3.verdict, after.rules.R5.verdict, after.universal!.U1.verdict, after.pass]).toEqual(["pass", "n/a", "pass", "pass", true]);
  });

  it("changes nothing when no children-completed wake followed the parent's yielded turn", () => {
    const record = parentRestedWaitingOnSubtasks();
    expect(withChildWaits(record, evidence(false))).toBe(record);
    expect(withChildWaits(record, null)).toBe(record);
    expect(gradeTask(withChildWaits(record, evidence(false)), [], 4_345 * SEC, pass).pass).toBe(false);
  });
});
