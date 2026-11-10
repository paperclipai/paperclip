import { describe, expect, it } from "vitest";
import { gradeTask } from "./grader.js";
import type { OracleArtifacts, RunSample, TaskRecord, TaskSample } from "./types.js";
import { bareCauseMessage, DEFAULT_UNIVERSAL_BOUNDS as BOUNDS, gradeU1, gradeU2, gradeU3, gradeU4, gradeUniversal, universalBounds } from "./universal.js";
import { workloadDefinitions } from "./workloads.js";

const T0 = Date.parse("2026-11-09T12:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const SEC = 1_000;

function run(id: string, status: string, created: number, finished: number | null = null, extra: Partial<RunSample> = {}): RunSample {
  return { id, status, createdAt: iso(created), startedAt: status === "queued" ? null : iso(created + 500),
    finishedAt: finished === null ? null : iso(finished), errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null,
    lastEvidenceAt: status === "running" ? iso(created + 500) : null, ...extra };
}
function sample(at: number, issueStatus: string, runs: RunSample[], extra: Partial<TaskSample> = {}): TaskSample {
  return { at: T0 + at, reachable: true, serverReady: true, issueStatus, interruption: null, activeRecoveryAction: false,
    executionBlocker: false, scheduledRetry: false, runs, ...extra };
}
/** A poll every 3 s from `from` to `to` (ms), built by `make`. */
function polls(from: number, to: number, make: (at: number) => TaskSample): TaskSample[] {
  const out: TaskSample[] = [];
  for (let at = from; at <= to; at += 3 * SEC) out.push(make(at));
  return out;
}
function record(samples: TaskSample[], extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    plan: { taskId: "t01", index: 0, workload: "A1", adapter: "codex", fault: "K1", fireAfterMs: 20_000, holdMs: 0, followUpAfterMs: null, nonce: "abcd1234" },
    issueId: "issue-1", identifier: "CHA-1", createdAt: T0, launchError: null, samples, retry: null, restAt: samples.at(-1)?.at ?? null,
    finalStatus: "done", deadlineAt: T0 + 3_600_000, timedOut: false, followUp: null, faultIds: [],
    sweep: { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null },
    preFaultFiles: null, lostFiles: null, ...extra,
  };
}
const retryable = { state: "failed", canRetry: true, retryWait: false, workspaceFailure: null, observedRunId: "r1", userAction: null };

describe("U1 liveness", () => {
  it("passes a task whose run keeps working, then finishes", () => {
    const samples = [...polls(0, 120 * SEC, at => sample(at, "in_progress", [run("r1", "running", 0, null, { lastEvidenceAt: iso(at) })])),
      sample(123 * SEC, "done", [run("r1", "succeeded", 0, 121 * SEC)])];
    expect(gradeU1(record(samples), BOUNDS).verdict).toBe("pass");
  });

  it("fails a run that stays queued past the queue bound with nothing else for the user (the #20361 shape)", () => {
    const samples = polls(0, 9 * 60 * SEC, at => sample(at, "todo", [run("r1", "queued", 0)]));
    const result = gradeU1(record(samples, { restAt: null, finalStatus: null, timedOut: true }), BOUNDS);
    expect(result.verdict).toBe("fail");
    expect(result.detail).toMatch(/^no_owner_no_action .* in todo with r1 queued/);
  });

  it("treats a visible Retry or a waiting question as actionable", () => {
    const failedRun = run("r1", "failed", 0, 5 * SEC, { errorCode: "process_lost" });
    const withRetry = polls(0, 10 * 60 * SEC, at => sample(at, "in_progress", [failedRun], { interruption: retryable }));
    expect(gradeU1(record(withRetry), BOUNDS).verdict).toBe("pass");
    const question = { ...retryable, state: "waiting_for_user", canRetry: false };
    expect(gradeU1(record(polls(0, 10 * 60 * SEC, at => sample(at, "in_progress", [failedRun], { interruption: question }))), BOUNDS).verdict).toBe("pass");
  });

  it("does not count outage time toward the bound", () => {
    const quiet = (at: number) => sample(at, "in_progress", [run("r1", "failed", 0, 5 * SEC, { errorCode: "process_lost" })]);
    const samples = [...polls(10 * SEC, 100 * SEC, quiet), { at: T0 + 101 * SEC, reachable: false, serverReady: false },
      { at: T0 + 400 * SEC, reachable: false, serverReady: false }, ...polls(401 * SEC, 480 * SEC, quiet)];
    expect(gradeU1(record(samples, { restAt: null }), BOUNDS).verdict).toBe("pass");
  });

  it("does not let a retry row keep a stuck dispatched retry run alive", () => {
    const samples = polls(0, 9 * 60 * SEC, at => sample(at, "todo", [run("r1", "queued", 0)], { scheduledRetry: true }));
    expect(gradeU1(record(samples, { restAt: null }), BOUNDS).verdict).toBe("fail");
    const pending = polls(0, 9 * 60 * SEC, at => sample(at, "todo", [run("r0", "failed", 0, SEC, { errorCode: "process_lost" })], { scheduledRetry: true }));
    expect(gradeU1(record(pending, { restAt: null }), BOUNDS).verdict).toBe("pass");
  });

  it("fails an accepted Retry that waits on the system past the bound with no run (w-20261110T050818-s20386)", () => {
    const waiting = { ...retryable, retryWait: true };
    const failedRun = run("r1", "failed", 0, SEC, { errorCode: "adapter_failed" });
    const samples = polls(0, 9 * 60 * SEC, at => sample(at, "blocked", [failedRun], { interruption: waiting, executionBlocker: true }));
    expect(gradeU1(record(samples, { restAt: null }), BOUNDS)).toMatchObject({ verdict: "fail",
      detail: expect.stringMatching(/accepted Retry waiting on the system/) });
    // A wait that names a person's action (confirm the previous run stopped) is actionable.
    const confirm = polls(0, 9 * 60 * SEC, at => sample(at, "blocked", [failedRun],
      { interruption: { ...waiting, userAction: "confirm_run_stopped" } }));
    expect(gradeU1(record(confirm, { restAt: null }), BOUNDS).verdict).toBe("pass");
    // A short wait that ends in a dispatched run is fine.
    const short = [...polls(0, 60 * SEC, at => sample(at, "blocked", [failedRun], { interruption: waiting })),
      sample(63 * SEC, "in_progress", [failedRun, run("r2", "running", 62 * SEC, null, { lastEvidenceAt: iso(63 * SEC) })])];
    expect(gradeU1(record(short, { restAt: null }), BOUNDS).verdict).toBe("pass");
  });

  it("fails a silent running run once it stops counting as an owner", () => {
    const samples = polls(0, 7 * 60 * SEC, at => sample(at, "in_progress", [run("r1", "running", 0)]));
    expect(gradeU1(record(samples, { restAt: null }), BOUNDS).verdict).toBe("fail");
  });
});

describe("U2 retry loops", () => {
  const failed = (id: string, at: number, code = "adapter_failed") => run(id, "failed", at, at + 5 * SEC, { errorCode: code });
  it("fails the same failure repeating without the task changing state", () => {
    const runs: RunSample[] = [];
    const samples = [0, 1, 2, 3].map(index => { runs.push(failed(`r${index}`, index * 20 * SEC)); return sample(index * 20 * SEC + 6 * SEC, "in_progress", [...runs]); });
    expect(gradeU2(record(samples), BOUNDS)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/same_failure_repeated 4x failed:adapter_failed/) });
  });
  it("resets the streak when a run succeeds between failures", () => {
    const succeeded = run("ok", "succeeded", 7 * SEC, 9 * SEC);
    const samples = [sample(60 * SEC, "in_progress", [failed("r0", 0), succeeded, failed("r1", 10 * SEC), failed("r2", 20 * SEC), failed("r3", 30 * SEC)])];
    expect(gradeU2(record(samples), BOUNDS)).toMatchObject({ verdict: "pass", metrics: { sameFailureRuns: 3 } });
  });
  it("resets the streak when the issue changed state between failures", () => {
    const all = [failed("r0", 0), failed("r1", 20 * SEC), failed("r2", 40 * SEC), failed("r3", 60 * SEC)];
    const samples = [sample(6 * SEC, "in_progress", all.slice(0, 1)), sample(26 * SEC, "in_progress", all.slice(0, 2)),
      sample(30 * SEC, "blocked", all.slice(0, 2)), sample(46 * SEC, "in_progress", all.slice(0, 3)), sample(66 * SEC, "in_progress", all)];
    expect(gradeU2(record(samples), BOUNDS)).toMatchObject({ verdict: "pass", metrics: { sameFailureRuns: 2 } });
  });
  it("passes when the failures differ or stay within the bound", () => {
    const samples = [sample(10 * SEC, "in_progress", [failed("r1", 0), failed("r2", 6 * SEC, "process_lost"), failed("r3", 12 * SEC)])];
    expect(gradeU2(record(samples), BOUNDS).verdict).toBe("pass");
  });
});

describe("U3 diagnosable failures", () => {
  it("flags a generic code, and a bare cause in the stored message", () => {
    const samples = [sample(10 * SEC, "done", [run("r1", "failed", 0, 5 * SEC, { errorCode: "adapter_failed" })])];
    expect(gradeU3(record(samples)).verdict).toBe("fail");
    const replay = [sample(10 * SEC, "done", [run("r2", "failed", 0, 5 * SEC, { errorCode: "native_event_replay_conflict" })])];
    expect(gradeU3(record(replay)).verdict).toBe("pass");
    const stalled = "native_event_replay_conflict: runner_event_commit_stalled: runner events kept failing to commit without progress "
      + "(last cause: Error at source seq 12); automatic recovery is stopped.";
    expect(gradeU3(record(replay), { runMessages: new Map([["r2", stalled]]), recoveryActions: [] }).verdict).toBe("fail");
    const coded = stalled.replace("last cause: Error", "last cause: 40001");
    expect(gradeU3(record(replay), { runMessages: new Map([["r2", coded]]), recoveryActions: [] }).verdict).toBe("pass");
  });
  it("flags a recovery action with an empty or bare cause", () => {
    const db = { runMessages: new Map(), recoveryActions: [{ id: "a1", kind: "stalled_issue", cause: "Error", nextAction: "Retry the task" }] };
    expect(gradeU3(record([sample(0, "done", [])]), db).verdict).toBe("fail");
  });
  it("recognizes bare causes", () => {
    expect(bareCauseMessage("Error")).toBe(true);
    expect(bareCauseMessage("")).toBe(true);
    expect(bareCauseMessage("failed (cause: unknown_error)")).toBe(true);
    expect(bareCauseMessage("Error at source seq 7")).toBe(true);
    expect(bareCauseMessage("Process exited with code 1: ENOENT spawn codex")).toBe(false);
  });
});

describe("U4 stale notices", () => {
  it("fails a Retry notice still shown after a later run succeeded", () => {
    const runs = [run("r1", "failed", 0, 5 * SEC, { errorCode: "process_lost" }), run("r2", "succeeded", 10 * SEC, 30 * SEC)];
    const samples = polls(31 * SEC, 31 * SEC + 2 * 60 * SEC, at => sample(at, "done", runs, { interruption: retryable }));
    expect(gradeU4(record(samples), BOUNDS)).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/^stale_notice Retry offered after r2 succeeded/) });
  });
  it("passes when the notice clears", () => {
    const runs = [run("r1", "failed", 0, 5 * SEC, { errorCode: "process_lost" }), run("r2", "succeeded", 10 * SEC, 30 * SEC)];
    const samples = [sample(31 * SEC, "done", runs, { interruption: retryable }), sample(34 * SEC, "done", runs)];
    expect(gradeU4(record(samples), BOUNDS).verdict).toBe("pass");
  });
});

describe("universal checks in the task grade", () => {
  const artifacts: OracleArtifacts = { issueStatus: "done", documents: { brief: "CHAOS-abcd1234\n- one\n- two\n- three\n" },
    agentComments: [], files: {}, commands: {}, workspacePath: null };
  it("fails a task on an enforced rule and keeps a warning rule from failing it", () => {
    const runs = [run("r1", "failed", 0, 5 * SEC, { errorCode: "adapter_failed" }), run("r2", "succeeded", 10 * SEC, 30 * SEC)];
    const stale = polls(31 * SEC, 31 * SEC + 2 * 60 * SEC, at => sample(at, "done", runs, { interruption: retryable }));
    const grade = gradeTask(record(stale), [], 600_000, workloadDefinitions.A1.grade("abcd1234", artifacts));
    expect(grade.universal?.U4).toMatchObject({ verdict: "fail", enforced: true });
    expect(grade.universal?.U3).toMatchObject({ verdict: "fail", enforced: false });
    expect(grade.pass).toBe(false);
    expect(grade.signature).toMatch(/^U4:stale_notice:A1:K1$/);

    const clean = [sample(31 * SEC, "done", runs)];
    const warned = gradeTask(record(clean), [], 600_000, workloadDefinitions.A1.grade("abcd1234", artifacts));
    expect(warned.universal?.U3.verdict).toBe("fail");
    expect(warned.pass).toBe(true);
  });
  it("reads bounds from the environment", () => {
    expect(universalBounds({ RESTART_CHAOS_U1_ORPHAN_SECONDS: "60", RESTART_CHAOS_U2_SAME_FAILURE_RUNS: "5" })).toMatchObject({ orphanMs: 60_000, sameFailureRuns: 5 });
    expect(() => universalBounds({ RESTART_CHAOS_U1_ORPHAN_SECONDS: "-1" })).toThrow();
    expect(gradeUniversal(record([sample(0, "done", [])])).U1.verdict).toBe("pass");
  });
});
