import { describe, expect, it } from "vitest";
import { crossingFaults, gradeR3, gradeR4, gradeR5, gradeTask, STALL_LIMIT_MS } from "./grader.js";
import { isResting } from "./observer.js";
import type { FaultReceipt, OracleArtifacts, RunSample, TaskRecord, TaskSample } from "./types.js";
import { BENCH_EXPECTED, parseBenchRecord, workloadDefinitions } from "./workloads.js";

const T0 = Date.parse("2026-11-06T12:00:00Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function run(id: string, status: string, created: number, finished: number | null = null, extra: Partial<RunSample> = {}): RunSample {
  return { id, status, createdAt: iso(created), startedAt: iso(created + 500), finishedAt: finished === null ? null : iso(finished),
    errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null, ...extra };
}

function sample(at: number, issueStatus: string, runs: RunSample[], extra: Partial<TaskSample> = {}): TaskSample {
  return { at: T0 + at, reachable: true, serverReady: true, issueStatus, interruption: null, activeRecoveryAction: false,
    executionBlocker: false, scheduledRetry: false, runs, ...extra };
}

function record(samples: TaskSample[], extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    plan: { taskId: "t01", index: 0, workload: "A1", adapter: "codex", fault: "K1", fireAfterMs: 20_000, holdMs: 0, followUpAfterMs: null, nonce: "abcd1234" },
    issueId: "issue-1", identifier: "CHA-1", createdAt: T0, launchError: null, samples, retry: null, restAt: T0 + 120_000,
    finalStatus: "done", deadlineAt: T0 + 600_000, timedOut: false, followUp: null, faultIds: ["f01"],
    sweep: { activeRuns: [], runningWorkspaceOperations: [], activeRecoveryAction: false, error: null },
    preFaultFiles: null, lostFiles: null, ...extra,
  };
}

const fault: FaultReceipt = { faultId: "f01", kind: "K1", requestedBy: "t01", signal: "SIGKILL", holdMs: 0, requestedAt: T0 + 20_000,
  startedAt: T0 + 20_000, stoppedAt: T0 + 21_000, restartedAt: T0 + 21_000, healthyAt: T0 + 40_000, readyAt: T0 + 45_000,
  phases: [{ phase: "unreachable", at: T0 + 21_000 }, { phase: "recovering", at: T0 + 38_000 }, { phase: "ready", at: T0 + 45_000 }],
  serverLogOffsetAtStart: 0, serverLogOffsetAtReady: 100, error: null };

const passingBrief: OracleArtifacts = { issueStatus: "done", documents: { brief: "CHAOS-abcd1234\n- one\n- two\n- three\n" },
  agentComments: [], files: {}, commands: {}, workspacePath: null };
const oracle = (artifacts = passingBrief) => workloadDefinitions.A1.grade("abcd1234", artifacts);

describe("R1–R6 grading on fixture timelines", () => {
  it("passes a task that auto-continued across a K1 kill", () => {
    const samples = [
      sample(3_000, "in_progress", [run("r1", "running", 1_000)]),
      { at: T0 + 25_000, reachable: false, serverReady: false },
      sample(50_000, "in_progress", [run("r1", "failed", 1_000, 30_000), run("r2", "running", 48_000)]),
      sample(110_000, "done", [run("r1", "failed", 1_000, 30_000), run("r2", "succeeded", 48_000, 100_000)]),
    ];
    const grade = gradeTask(record(samples), [fault], workloadDefinitions.A1.budgetMs, oracle());
    expect(grade.crossed).toBe(true);
    expect(grade.crossingFaults).toEqual(["f01"]);
    expect(grade.rules.R1.verdict).toBe("pass");
    expect(grade.rules.R3.verdict).toBe("n/a");
    expect(grade.pass).toBe(true);
    expect(grade.signature).toBeNull();
  });

  it("does not count a task that rested before the fault as restart-crossing", () => {
    const samples = [sample(3_000, "done", [run("r1", "succeeded", 1_000, 10_000)])];
    expect(crossingFaults(record(samples, { restAt: T0 + 12_000 }), [fault])).toEqual([]);
  });

  it("fails R1 and R3 when a task rests unfinished with no Retry offered", () => {
    const samples = [sample(60_000, "in_progress", [run("r1", "failed", 1_000, 30_000)])];
    const grade = gradeTask(record(samples, { finalStatus: "in_progress" }), [fault], workloadDefinitions.A1.budgetMs,
      oracle({ ...passingBrief, issueStatus: "in_progress", documents: { brief: null } }));
    expect(grade.rules.R1).toMatchObject({ verdict: "fail" });
    expect(grade.rules.R1.detail).toMatch(/rested_not_done/);
    expect(grade.rules.R3.detail).toMatch(/missing_retry/);
    expect(grade.signature).toBe("R1:rested_not_done:A1:K1");
  });

  it("passes R3 when one Retry starts a run that completes the task", () => {
    const samples = [
      sample(60_000, "blocked", [run("r1", "failed", 1_000, 30_000)], { interruption: { state: "failed", canRetry: true, retryWait: false, workspaceFailure: null, observedRunId: "r1", userAction: null } }),
      sample(80_000, "in_progress", [run("r1", "failed", 1_000, 30_000), run("r2", "running", 75_000, null, { retryOfRunId: "r1" })]),
      sample(140_000, "done", [run("r1", "failed", 1_000, 30_000), run("r2", "succeeded", 75_000, 130_000)]),
    ];
    const retried = record(samples, { retry: { at: T0 + 74_000, observedRunId: "r1", httpStatus: 200, accepted: true, error: null }, restAt: T0 + 140_000 });
    expect(gradeR3(retried)).toMatchObject({ verdict: "pass" });
    const grade = gradeTask(retried, [fault], workloadDefinitions.A1.budgetMs, oracle());
    expect(grade.rules.R1.verdict).toBe("n/a");
    expect(grade.pass).toBe(true);
  });

  it("fails R3 for a dead Retry (accepted but no new run)", () => {
    const samples = [sample(60_000, "blocked", [run("r1", "failed", 1_000, 30_000)])];
    const dead = record(samples, { finalStatus: "blocked", retry: { at: T0 + 74_000, observedRunId: "r1", httpStatus: 200, accepted: true, error: null } });
    expect(gradeR3(dead).detail).toBe("retry_no_new_run");
    const rejected = record(samples, { finalStatus: "blocked", retry: { at: T0 + 74_000, observedRunId: "r1", httpStatus: 409, accepted: null, error: "conflict" } });
    expect(gradeR3(rejected).detail).toMatch(/^retry_rejected/);
  });

  it("passes R4 for a queued wake that is cancelled behind a running run without executing", () => {
    // Shape of w-20261107T013205-s11/t06: a follow-up comment queued a run while
    // the first run was running; it was cancelled when the first one succeeded.
    const queuedWake = run("w2", "queued", 30_000, null, { startedAt: null, wakeCommentIds: ["c1"] });
    const samples = [
      sample(10_000, "in_progress", [run("r1", "running", 1_000)]),
      sample(35_000, "in_progress", [run("r1", "running", 1_000), queuedWake]),
      sample(45_000, "in_progress", [run("r1", "succeeded", 1_000, 40_000), { ...queuedWake, status: "cancelled", finishedAt: iso(41_000) }]),
    ];
    expect(gradeR4(record(samples))).toMatchObject({ verdict: "pass" });
    // The same queued/scheduled shapes never fail on their own either.
    expect(gradeR4(record([sample(10_000, "in_progress", [run("r1", "queued", 1_000, null, { startedAt: null }),
      run("r2", "scheduled_retry", 5_000, null, { startedAt: null })])])).verdict).toBe("pass");
  });

  it("fails R4 for two concurrent running runs and for a comment consumed twice", () => {
    expect(gradeR4(record([sample(10_000, "in_progress", [run("r1", "running", 1_000), run("r2", "running", 5_000)])])).detail).toMatch(/concurrent_runs/);
    const twice = [sample(90_000, "done", [
      run("r1", "succeeded", 1_000, 40_000, { wakeCommentIds: ["c1"] }),
      run("r2", "succeeded", 50_000, 80_000, { wakeCommentIds: ["c1"] }),
    ])];
    expect(gradeR4(record(twice)).detail).toMatch(/comment_consumed_twice: c1/);
    // Runs whose execution windows overlap fail even if no single poll saw both running.
    const overlapped = [sample(90_000, "done", [run("r1", "succeeded", 1_000, 40_000), run("r2", "failed", 20_000, 60_000)])];
    expect(gradeR4(record(overlapped)).detail).toMatch(/concurrent_runs: r1\(succeeded\),r2\(failed\) executed together/);
    // A failed run's comment may be served again by the retry; a successful one may not.
    const retried = [sample(90_000, "done", [
      run("r1", "failed", 1_000, 40_000, { wakeCommentIds: ["c1"] }),
      run("r2", "succeeded", 50_000, 80_000, { wakeCommentIds: ["c1"], retryOfRunId: "r1" }),
    ])];
    expect(gradeR4(record(retried)).verdict).toBe("pass");
    const afterSuccess = [sample(90_000, "done", [
      run("r1", "succeeded", 1_000, 40_000, { wakeCommentIds: ["c1"] }),
      run("r2", "failed", 50_000, 80_000, { wakeCommentIds: ["c1"] }),
    ])];
    expect(gradeR4(record(afterSuccess)).detail).toMatch(/comment_consumed_twice: c1 by r1,r2/);
  });

  // s9401/t72: the message's run was claimed just before the first run ended,
  // then cancelled as stale before dispatch; a later run delivered the message.
  it("passes R4 for a stale continuation cancelled before dispatch whose message a later run delivered once", () => {
    const samples = [sample(90_000, "done", [
      run("r1", "succeeded", 1_000, 40_000),
      run("r2", "cancelled", 30_000, 40_060, { startedAt: iso(39_960), wakeCommentIds: ["c1"],
        errorCode: "continuation_task_ownership_changed" }),
      run("r3", "succeeded", 45_000, 80_000, { wakeCommentIds: ["c1"] }),
    ])];
    expect(gradeR4(record(samples))).toMatchObject({ verdict: "pass" });
    // A poll that saw both running (claiming marks running before dispatch)
    // does not change that.
    const polled = [sample(39_990, "in_progress", [run("r1", "running", 1_000), run("r2", "running", 30_000, null, { startedAt: iso(39_960) })]),
      ...samples];
    expect(gradeR4(record(polled))).toMatchObject({ verdict: "pass" });
    // Any other cancelled run that overlapped still executed.
    const executed = [sample(90_000, "done", [run("r1", "succeeded", 1_000, 40_000),
      run("r2", "cancelled", 30_000, 40_060, { startedAt: iso(39_960), errorCode: "cancelled" })])];
    expect(gradeR4(record(executed)).detail).toMatch(/concurrent_runs/);
  });

  it("fails R5 on a silent stall longer than three minutes after ready, but not during outages or named waits", () => {
    const idle = (at: number, extra: Partial<TaskSample> = {}) => sample(at, "in_progress", [run("r1", "failed", 1_000, 30_000)], extra);
    const stalled = [idle(60_000), idle(60_000 + STALL_LIMIT_MS / 2), idle(60_000 + STALL_LIMIT_MS + 5_000)];
    expect(gradeR5(record(stalled))).toMatchObject({ verdict: "fail" });
    const outage = [idle(60_000), { at: T0 + 120_000, reachable: false, serverReady: false }, idle(200_000), idle(300_000)];
    expect(gradeR5(record(outage))).toMatchObject({ verdict: "pass" });
    const named = stalled.map(entry => ({ ...entry, scheduledRetry: true }));
    expect(gradeR5(record(named))).toMatchObject({ verdict: "pass" });
  });

  it("fails R2 when a workspace failure stays visible and R6 when work is left pending", () => {
    const failure = { state: "failed", canRetry: false, retryWait: false, workspaceFailure: "snapshot restore failed", observedRunId: "r1", userAction: null };
    const grade = gradeTask(record([sample(90_000, "done", [run("r1", "succeeded", 1_000, 80_000)], { interruption: failure })]), [fault], 600_000, oracle());
    expect(grade.rules.R2.detail).toMatch(/workspace_failure_visible_at_rest/);
    const leaky = record([sample(90_000, "done", [run("r1", "succeeded", 1_000, 80_000)])],
      { sweep: { activeRuns: [], runningWorkspaceOperations: ["op1"], activeRecoveryAction: true, error: null } });
    expect(gradeTask(leaky, [fault], 600_000, oracle()).rules.R6.detail).toMatch(/running_workspace_operations=op1; active_recovery_action/);
  });

  it("fails R2 when files written before the fault are gone at rest", () => {
    const done = [sample(90_000, "done", [run("r1", "succeeded", 1_000, 80_000)])];
    const lost = record(done, { preFaultFiles: ["NOTES.md", "chaoscli/cli.py"], lostFiles: ["NOTES.md"] });
    expect(gradeTask(lost, [fault], 600_000, oracle()).rules.R2.detail).toBe("pre_fault_files_lost: NOTES.md");
    expect(gradeTask(record(done, { preFaultFiles: ["NOTES.md"], lostFiles: [] }), [fault], 600_000, oracle()).rules.R2.verdict).toBe("pass");
  });

  it("fails R2 visibly when the pre-fault snapshot could not run", () => {
    const done = [sample(90_000, "done", [run("r1", "succeeded", 1_000, 80_000)])];
    const unchecked = record(done, { preFaultSnapshotError: "EACCES" });
    expect(gradeTask(unchecked, [fault], 600_000, oracle()).rules.R2.detail).toMatch(/^pre_fault_snapshot_failed/);
  });

  it("allows outage time on top of the budget", () => {
    const k4: FaultReceipt = { ...fault, kind: "K4", holdMs: 240_000, readyAt: T0 + 290_000 };
    const late = record([sample(700_000, "done", [run("r2", "succeeded", 300_000, 690_000)])], { restAt: T0 + 700_000 });
    expect(gradeTask(late, [k4], 600_000, oracle()).rules.R1.verdict).toBe("pass");
    expect(gradeTask(late, [], 600_000, oracle()).rules.R1.detail).toMatch(/done_too_late/);
  });
});

describe("T-oracles", () => {
  it("grades A1 and C1 markers", () => {
    expect(workloadDefinitions.A1.grade("abcd1234", passingBrief).verdict).toBe("pass");
    expect(workloadDefinitions.C1.grade("abcd1234", passingBrief).checks.find(check => check.name.includes("followup"))?.ok).toBe(false);
    expect(workloadDefinitions.C1.grade("abcd1234", { ...passingBrief, documents: { brief: `${passingBrief.documents.brief}FOLLOWUP-abcd1234\n` } }).verdict).toBe("pass");
  });

  it("grades B1 by running the tests and the CLI", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: {}, agentComments: [], workspacePath: "/tmp/ws",
      files: { "NOTES-abcd1234.md": "B1-abcd1234\n" },
      commands: { unittest: { exitCode: 0, stdout: "", stderr: "OK" }, slugify: { exitCode: 0, stdout: "hello-chaos-world\n", stderr: "" } } };
    expect(workloadDefinitions.B1.grade("abcd1234", base).verdict).toBe("pass");
    expect(workloadDefinitions.B1.grade("abcd1234", { ...base, commands: { ...base.commands, unittest: { exitCode: 1, stdout: "", stderr: "FAILED" } } }).verdict).toBe("fail");
  });

  it("grades B5 against the deterministic bench result", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: {}, agentComments: [], workspacePath: "/tmp/ws", commands: {},
      benchProgressObserved: 6,
      files: { "bench-result-abcd1234.txt": `${BENCH_EXPECTED}\n`, ".bench/run-abcd1234.txt": `started=1000 finished=1241 result=${BENCH_EXPECTED}\n` } };
    expect(BENCH_EXPECTED).toBe("BENCH_RESULT=4636840");
    expect(parseBenchRecord(base.files[".bench/run-abcd1234.txt"])).toEqual({ seconds: 241, result: BENCH_EXPECTED });
    expect(workloadDefinitions.B5.grade("abcd1234", base).verdict).toBe("pass");
    // A forged record without harness-observed progress does not pass.
    expect(workloadDefinitions.B5.grade("abcd1234", { ...base, benchProgressObserved: 1 }).checks.find(c => c.name === "bench_progress_observed")?.ok).toBe(false);
    expect(workloadDefinitions.B5.grade("abcd1234", { ...base, files: { ...base.files, "bench-result-abcd1234.txt": "BENCH_RESULT=1" } }).verdict).toBe("fail");
    // A computed answer without a bench.sh run, or a too-short run, does not pass.
    expect(workloadDefinitions.B5.grade("abcd1234", { ...base, files: { "bench-result-abcd1234.txt": BENCH_EXPECTED } }).checks.find(c => c.name === "bench_actually_ran")?.ok).toBe(false);
    expect(workloadDefinitions.B5.grade("abcd1234", { ...base, files: { ...base.files, ".bench/run-abcd1234.txt": `started=1000 finished=1010 result=${BENCH_EXPECTED}` } }).verdict).toBe("fail");
  });
});

describe("rest detection", () => {
  it("is not resting while a run, scheduled retry or recovery is live", () => {
    expect(isResting(sample(0, "in_progress", [run("r1", "queued", 0)]))).toBe(false);
    expect(isResting(sample(0, "in_progress", [], { scheduledRetry: true }))).toBe(false);
    expect(isResting(sample(0, "done", [run("r1", "succeeded", 0, 10)]))).toBe(true);
    // Unexplained idle work is a possible stall, not a rest; a visible Retry is a rest.
    expect(isResting(sample(0, "in_progress", [run("r1", "failed", 0, 10)]))).toBe(false);
    expect(isResting(sample(0, "in_progress", [run("r1", "failed", 0, 10)], { interruption: { state: "failed", canRetry: true, retryWait: false, workspaceFailure: null, observedRunId: "r1", userAction: null } }))).toBe(true);
    expect(isResting({ at: T0, reachable: false, serverReady: false })).toBe(false);
    expect(isResting(sample(0, "blocked", [], { activeRecoveryAction: true, recoveryOwner: "agent" }))).toBe(false);
    // A board-owned recovery waits on a person, so the task rests (and R6 reports it).
    expect(isResting(sample(0, "blocked", [], { activeRecoveryAction: true, recoveryOwner: "board" }))).toBe(true);
  });
});
