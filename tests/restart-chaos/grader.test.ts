import { describe, expect, it } from "vitest";
import { QUEUE_HANDOFF_TOLERANCE_MS, queueWaitFairnessFrom, type AgentSlots } from "./agent-slots.js";
import { crossingFaults, gradeR1, gradeR2, gradeR3, gradeR4, gradeR5, gradeTask, STALL_LIMIT_MS } from "./grader.js";
import { isResting } from "./observer.js";
import { runWakesFrom } from "./wave-grade-inputs.js";
import type { FaultReceipt, OracleArtifacts, RunSample, TaskRecord, TaskSample } from "./types.js";
import { BENCH_EXPECTED, parseBenchRecord, r1TestChecksSlug, stallWakeChecks, workloadDefinitions } from "./workloads.js";

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

  it("fails R3 when the task needed a Retry, even one that completed it, and names a second click", () => {
    const samples = [
      sample(60_000, "blocked", [run("r1", "failed", 1_000, 30_000)], { interruption: { state: "failed", canRetry: true, retryWait: false, workspaceFailure: null, observedRunId: "r1", userAction: null } }),
      sample(80_000, "in_progress", [run("r1", "failed", 1_000, 30_000), run("r2", "running", 75_000, null, { retryOfRunId: "r1" })]),
      sample(140_000, "done", [run("r1", "failed", 1_000, 30_000), run("r2", "succeeded", 75_000, 130_000)]),
    ];
    const retried = record(samples, { retry: { at: T0 + 74_000, observedRunId: "r1", httpStatus: 200, accepted: true, error: null }, restAt: T0 + 140_000 });
    expect(gradeR3(retried)).toEqual({ verdict: "fail", detail: "retry_needed (failed)" });
    const grade = gradeTask(retried, [fault], workloadDefinitions.A1.budgetMs, oracle());
    expect(grade.rules.R1.verdict).toBe("n/a");
    expect(grade.pass).toBe(false);
    const twice = record(samples, { retry: { at: T0 + 74_000, observedRunId: "r1", httpStatus: 200, accepted: true, error: null },
      priorRetries: [{ at: T0 + 50_000, observedRunId: "r0", httpStatus: 200, accepted: true, error: null }], restAt: T0 + 140_000 });
    expect(gradeR3(twice).detail).toBe("retry_needed_2_clicks (failed)");
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

describe("R1 fair queue wait credit", () => {
  const BUDGET = 2_200_000;
  const WAIT = 1_509_000;
  const CREATED = 50;
  const STARTED = CREATED + WAIT;
  type SlotRun = AgentSlots["runs"][number];
  const slotRun = (runId: string, created: number, started: number, finished: number | null): SlotRun =>
    ({ runId, agentId: "agent-oc", createdAt: T0 + created, invocationSource: "assignment", retryOfRunId: null, startedAt: T0 + started,
      finishedAt: finished === null ? null : T0 + finished });
  const own = (started: number = STARTED): SlotRun => ({ runId: "r1", agentId: "agent-oc", createdAt: T0 + CREATED, startedAt: T0 + started, finishedAt: null });
  const fullAgent = (): SlotRun[] => [
    slotRun("o1", -900_000, -800_000, 400_000),
    slotRun("o2", -900_000, -700_000, 900_000),
    slotRun("o3", -900_000, -600_000, STARTED),
    slotRun("o4", -900_000, -500_000, 2_000_000),
    slotRun("o5", 10, 400_000, 2_100_000),
    slotRun("o6", 20, 901_000, 2_100_000),
  ];
  const slots = (runs: SlotRun[]): AgentSlots => ({ agents: [{ agentId: "agent-oc", maxConcurrentRuns: 4 }], runs: [own(), ...runs] });
  const queued = (tookMs: number, wait = WAIT) => record([
    sample(60_000, "in_progress", [run("r1", "queued", CREATED, null, { startedAt: null })]),
    sample(CREATED + wait + 5_000, "in_progress", [run("r1", "running", CREATED, null, { startedAt: iso(CREATED + wait) })]),
    sample(tookMs, "done", [run("r1", "succeeded", CREATED, tookMs - 1_000, { startedAt: iso(CREATED + wait) })]),
  ], { restAt: T0 + tookMs, faultIds: [] });
  const t031 = () => queued(BUDGET + 87_000);

  it("credits a fair 1,509 s FIFO queue wait that left the task 87 s over the old budget", () => {
    expect(gradeR1(t031(), BUDGET, [])).toEqual({ verdict: "fail", detail: "done_too_late 2287s > 2200s (queue wait not credited: no agent slot evidence for r1)" });
    const graded = gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(fullAgent())));
    expect(graded).toEqual({ verdict: "pass", detail: "done after 2287s (allowed 3709s incl. 1509s fair queue wait)" });
  });

  it("fails as an unfair queue wait when a newer run started ahead of the queued run", () => {
    const runs = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: T0 + 300_000 } : entry);
    const graded = gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(runs)));
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toMatch(/^unfair_queue_wait assignment run o6 created .* ahead of r1/);
    const task = gradeTask(t031(), [], BUDGET, oracle(), undefined, { queueWait: queueWaitFairnessFrom(slots(runs)) });
    expect(task.signature).toBe("R1:unfair_queue_wait:A1:K1");
  });

  it("fails as an unfair queue wait when the agent had an idle slot during the wait", () => {
    const runs = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, startedAt: T0 + 931_000 } : entry);
    const graded = gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(runs)));
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toContain(`idle slot from ${iso(900_000)} to ${iso(931_000)} while r1 was queued`);
  });

  it("credits the wait when a newer follow-up or retry that the dispatcher ranks higher started ahead", () => {
    const followUp = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: T0 + 300_000, invocationSource: "on_demand" } : entry);
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(followUp))).verdict).toBe("pass");
    const retry = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: T0 + 300_000, retryOfRunId: "o2" } : entry);
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(retry))).verdict).toBe("pass");
    for (const invocationSource of [undefined, null]) {
      const unclassified = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: T0 + 300_000, invocationSource } : entry);
      expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(unclassified))).detail)
        .toBe("done_too_late 2287s > 2200s (queue wait not credited: no invocation source for newer run o6, which started while r1 was queued)");
    }
    const malformed = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: Number.NaN } : entry);
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(malformed))).detail)
      .toBe("done_too_late 2287s > 2200s (queue wait not credited: no createdAt for o6, which started while r1 was queued)");
    for (const field of ["startedAt", "finishedAt"] as const) {
      const badTime = fullAgent().map(entry => entry.runId === "o2" ? { ...entry, [field]: Number.NaN } : entry);
      expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(badTime))).detail)
        .toBe("done_too_late 2287s > 2200s (queue wait not credited: malformed start or finish time for o2)");
    }
  });

  it("does not call an idle slot during a server outage unfair", () => {
    const runs = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, startedAt: T0 + 931_000 } : entry);
    const outage: FaultReceipt = { ...fault, startedAt: T0 + 890_000, readyAt: T0 + 930_000 };
    const graded = gradeR1(t031(), BUDGET, [outage], queueWaitFairnessFrom(slots(runs)));
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toMatch(/^done_too_late .*queue wait not credited: idle slot from .* overlapped a server outage while r1 was queued/);
  });

  it("allows a same-second slot hand-off within the tolerance", () => {
    const runs = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, startedAt: T0 + 900_000 + QUEUE_HANDOFF_TOLERANCE_MS } : entry);
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(runs))).verdict).toBe("pass");
  });

  it("does not credit a wait it cannot prove fair", () => {
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(null)).detail)
      .toBe("done_too_late 2287s > 2200s (queue wait not credited: no agent slot evidence for r1)");
    const runs = fullAgent().map(entry => entry.runId === "o6" ? { ...entry, createdAt: null } : entry);
    expect(gradeR1(t031(), BUDGET, [], queueWaitFairnessFrom(slots(runs))).detail)
      .toBe("done_too_late 2287s > 2200s (queue wait not credited: no createdAt for o6, which started while r1 was queued)");
  });

  it("says so when the first run never started", () => {
    const cancelled = record([sample(BUDGET + 87_000, "done", [
      run("r0", "cancelled", 0, 1_000, { startedAt: null }),
      run("r1", "succeeded", CREATED, BUDGET, { startedAt: iso(STARTED) }),
    ])], { restAt: T0 + BUDGET + 87_000, faultIds: [] });
    expect(gradeR1(cancelled, BUDGET, [], queueWaitFairnessFrom(slots(fullAgent()))).detail)
      .toBe("done_too_late 2287s > 2200s (queue wait not credited: first run r0 never started)");
  });

  it("leaves a short queue wait unchanged", () => {
    const wait = 3_000;
    const runs = [slotRun("o1", -900_000, -800_000, CREATED + wait), slotRun("o2", 10, 1_000, 900_000)];
    const fairness = queueWaitFairnessFrom({ agents: [{ agentId: "agent-oc", maxConcurrentRuns: 4 }], runs: [own(CREATED + wait), ...runs] });
    const inBudget = queued(BUDGET - 10_000, wait);
    expect(gradeR1(inBudget, BUDGET, [], fairness)).toEqual(gradeR1(inBudget, BUDGET, []));
    expect(gradeR1(inBudget, BUDGET, [], fairness)).toEqual({ verdict: "pass", detail: "done after 2190s (allowed 2200s)" });
    expect(gradeR1(queued(BUDGET + 87_000, wait), BUDGET, [], fairness).verdict).toBe("fail");
  });

  it("credits only the first run's initial wait, not outage time inside it or later retries", () => {
    const outage: FaultReceipt = { ...fault, startedAt: T0 + 100_000, readyAt: T0 + 200_000 };
    const graded = gradeR1(queued(BUDGET + 1_550_000), BUDGET, [outage], queueWaitFairnessFrom(slots(fullAgent())));
    expect(graded).toEqual({ verdict: "fail", detail: "done_too_late 3750s > 3709s incl. 1409s fair queue wait" });
    const retried = record([sample(BUDGET + 87_000, "done", [
      run("r0", "failed", 0, 1_000),
      run("r1", "succeeded", CREATED, BUDGET, { startedAt: iso(STARTED), retryOfRunId: "r0" }),
    ])], { restAt: T0 + BUDGET + 87_000, faultIds: [] });
    const retriedGrade = gradeR1(retried, BUDGET, [], queueWaitFairnessFrom(slots(fullAgent())));
    expect(retriedGrade.verdict).toBe("fail");
    expect(retriedGrade.detail).toMatch(/^done_too_late 2287s > 2200s/);
    expect(retriedGrade.detail).not.toContain("fair queue wait");
  });
});

describe("R1 follow-up queue wait credit", () => {
  const BUDGET = 2_010_000;
  const WAIT = 1_558_000;
  type SlotRun = AgentSlots["runs"][number];
  const slotRun = (runId: string, created: number, started: number, finished: number | null, extra: Partial<SlotRun> = {}): SlotRun =>
    ({ runId, agentId: "agent-oc", createdAt: T0 + created, invocationSource: "assignment", retryOfRunId: null, startedAt: T0 + started,
      finishedAt: finished === null ? null : T0 + finished, ...extra });
  const shape = (firstWait = 0) => {
    const firstStart = 50 + firstWait;
    const firstEnd = firstStart + 666_000;
    const queuedAt = firstEnd + 50;
    const startedAt = queuedAt + WAIT;
    return { firstStart, firstEnd, queuedAt, startedAt };
  };
  const agent = (firstWait = 0, followUp: Partial<SlotRun> = {}): SlotRun[] => {
    const { firstStart, firstEnd, queuedAt, startedAt } = shape(firstWait);
    return [
      slotRun("r1", 50, firstStart, firstEnd),
      slotRun("r2", queuedAt, startedAt, null, { invocationSource: "automation", ...followUp }),
      slotRun("o1", -900_000, -800_000, firstStart),
      slotRun("o2", -900_000, -700_000, 1_400_000 + firstWait),
      slotRun("o3", -900_000, -600_000, startedAt),
      slotRun("o4", -900_000, -500_000, 600_000 + firstWait),
      slotRun("o5", 10, 600_000 + firstWait, 2_400_000 + firstWait),
      slotRun("o6", 20, firstEnd, 2_500_000 + firstWait),
      slotRun("o7", 30, 1_400_000 + firstWait, 2_600_000 + firstWait),
    ];
  };
  const slots = (runs: SlotRun[]): AgentSlots => ({ agents: [{ agentId: "agent-oc", maxConcurrentRuns: 4 }], runs });
  const followUpTask = (tookMs: number, firstWait = 0, follow: Partial<RunSample> = {}, first: Partial<RunSample> = {},
    extra: Partial<TaskRecord> = {}, others: RunSample[] = []) => {
    const { firstStart, firstEnd, queuedAt, startedAt } = shape(firstWait);
    const r1 = run("r1", "succeeded", 50, firstEnd, { startedAt: iso(firstStart), ...first });
    const r2 = (status: string, started: number | null, finished: number | null) =>
      run("r2", status, queuedAt, finished, { startedAt: started === null ? null : iso(started), wakeCommentIds: ["c1"], ...follow });
    return record([
      sample(queuedAt + 5_000, "in_progress", [r1, r2("queued", null, null), ...others]),
      sample(startedAt + 5_000, "in_progress", [r1, r2("running", startedAt, null), ...others]),
      sample(tookMs, "done", [r1, r2("succeeded", startedAt, tookMs - 1_000), ...others]),
    ], { restAt: T0 + tookMs, faultIds: [], plan: { ...record([]).plan, workload: "SM" },
      stagingMix: { followUp: { at: T0 + 200_000, commentId: "c1", duringRun: true, inOverlap: false, error: null } },
      runWakes: { r1: { wakeReason: "issue_assigned", continuesRunIds: [] }, r2: { wakeReason: "issue_commented", continuesRunIds: [] } }, ...extra });
  };
  const t007 = () => followUpTask(2_310_000);

  it("credits a fair 1,558 s follow-up queue wait behind the agent's older assignments", () => {
    expect(gradeR1(t007(), BUDGET, [])).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s (queue wait not credited: no agent slot evidence for r2)" });
    expect(gradeR1(t007(), BUDGET, [], queueWaitFairnessFrom(slots(agent()))))
      .toEqual({ verdict: "pass", detail: "done after 2310s (allowed 3568s incl. 1558s fair queue wait)" });
  });

  it("fails as unfair when a newer fresh assignment started ahead of the follow-up", () => {
    const runs = agent().map(entry => entry.runId === "o7" ? { ...entry, createdAt: T0 + 700_000 } : entry);
    const graded = gradeR1(t007(), BUDGET, [], queueWaitFairnessFrom(slots(runs)));
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toMatch(/^unfair_queue_wait assignment run o7 created .* ahead of r2; done 2310s > 2010s without queue credit$/);
    const task = gradeTask(t007(), [], BUDGET, oracle(), undefined, { queueWait: queueWaitFairnessFrom(slots(runs)) });
    expect(task.signature).toMatch(/^R1:unfair_queue_wait/);
  });

  it("fails as unfair when a slot sat idle while the follow-up was queued", () => {
    const runs = agent().map(entry => entry.runId === "o7" ? { ...entry, startedAt: T0 + 1_431_000 } : entry);
    const graded = gradeR1(t007(), BUDGET, [], queueWaitFairnessFrom(slots(runs)));
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toContain(`idle slot from ${iso(1_400_000)} to ${iso(1_431_000)} while r2 was queued`);
  });

  it("does not credit the wait of a retry or a recovery run", () => {
    const fairness = queueWaitFairnessFrom(slots(agent()));
    const retry = gradeR1(followUpTask(2_310_000, 0, { retryOfRunId: "r1" }), BUDGET, [], fairness);
    expect(retry).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
    const afterInterruption = gradeR1(followUpTask(2_310_000, 0, {}, { status: "failed", errorCode: "process_lost" }), BUDGET, [], fairness);
    expect(afterInterruption).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
    const continuation = gradeR1(followUpTask(2_310_000, 0, { wakeCommentIds: [] }), BUDGET, [], fairness);
    expect(continuation).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
  });

  it("does not credit a follow-up run created while the previous run was still running", () => {
    const { queuedAt } = shape();
    const overlapping = followUpTask(2_310_000, 0, {}, { finishedAt: iso(queuedAt + 10_000) });
    expect(gradeR1(overlapping, BUDGET, [], queueWaitFairnessFrom(slots(agent())))).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
  });

  it("credits a fair wait of a run woken by an after-end follow-up, but not after a recovery", () => {
    const { firstEnd } = shape();
    const afterEnd = { stagingMix: { afterEndFollowUps: [{ afterRunEndAt: T0 + firstEnd, at: T0 + firstEnd + 10, delayMs: 10, commentId: "c1" }] } };
    const fairness = queueWaitFairnessFrom(slots(agent()));
    expect(gradeR1(followUpTask(2_310_000, 0, {}, {}, afterEnd), BUDGET, [], fairness))
      .toEqual({ verdict: "pass", detail: "done after 2310s (allowed 3568s incl. 1558s fair queue wait)" });
    expect(gradeR1(followUpTask(2_310_000, 0, {}, { status: "failed", errorCode: "process_lost" }, afterEnd), BUDGET, [], fairness))
      .toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
  });

  it("refuses follow-up credit when an earlier run has no createdAt", () => {
    const undated = run("rx", "failed", 100_000, 600_000, { createdAt: null, errorCode: "process_lost" });
    const graded = gradeR1(followUpTask(2_310_000, 0, {}, {}, {}, [undated]), BUDGET, [], queueWaitFairnessFrom(slots(agent())));
    expect(graded).toEqual({ verdict: "fail",
      detail: "done_too_late 2310s > 2010s (queue wait not credited: no createdAt for rx, so runs cannot be ordered)" });
  });

  it("does not credit a recovery run that carries the comment after a success", () => {
    const fairness = queueWaitFairnessFrom(slots(agent()));
    for (const r2 of [{ wakeReason: "issue_continuation_needed", continuesRunIds: [] }, { wakeReason: "issue_commented", continuesRunIds: ["r1"] }]) {
      const recovery = followUpTask(2_310_000, 0, {}, {}, { runWakes: { r2 } });
      expect(gradeR1(recovery, BUDGET, [], fairness)).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
    }
  });

  it("reads each run's wake reason and continued runs from the wake evidence", () => {
    const run = (runId: string, wakeupRequestId: string | null, contextSnapshot: unknown) =>
      ({ runId, createdAt: 1, invocationSource: "automation", triggerDetail: "system", wakeupRequestId, contextSnapshot });
    expect(runWakesFrom({
      runs: [run("r2", "w2", { wakeReason: "issue_commented" }), run("r3", "w3", { executionContinuation: { interruptedRunId: "r2" } })],
      wakes: [{ id: "w2", reason: "issue_execution_promoted", source: "automation", triggerDetail: "system", requestedByActorType: "user", requestedByActorId: "u" },
        { id: "w3", reason: "issue_continuation_needed", source: "automation", triggerDetail: "system", requestedByActorType: null, requestedByActorId: null }],
    })).toEqual({ r2: { wakeReason: "issue_commented", continuesRunIds: [] }, r3: { wakeReason: "issue_continuation_needed", continuesRunIds: ["r2"] } });
  });

  it("does not credit a run created before its follow-up comment was posted", () => {
    const { queuedAt } = shape();
    const fairness = queueWaitFairnessFrom(slots(agent()));
    const early = (at: number | undefined) => followUpTask(2_310_000, 0, {}, {},
      { stagingMix: { followUp: { at: at as number, commentId: "c1", duringRun: true, inOverlap: false, error: null } } });
    expect(gradeR1(early(T0 + queuedAt + 200_000), BUDGET, [], fairness)).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s" });
    expect(gradeR1(early(undefined), BUDGET, [], fairness))
      .toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s (queue wait not credited: no send time for follow-up comment c1)" });
  });

  it("credits a run created after the comment request was sent but before it returned", () => {
    const { queuedAt } = shape();
    const followUp = { at: T0 + queuedAt - 1_000, sentAt: T0 + queuedAt - 500, postedAt: T0 + queuedAt + 400, commentId: "c1", error: null };
    expect(gradeR1(followUpTask(2_310_000, 0, {}, {}, { stagingMix: {}, followUp }), BUDGET, [], queueWaitFairnessFrom(slots(agent()))))
      .toEqual({ verdict: "pass", detail: "done after 2310s (allowed 3568s incl. 1558s fair queue wait)" });
  });

  it("credits nothing when the earliest run has no createdAt", () => {
    const undated = run("r0", "failed", -10_000, 40, { createdAt: null, errorCode: "process_lost" });
    const graded = gradeR1(followUpTask(2_610_000, 300_000, {}, {}, {}, [undated]), BUDGET, [], queueWaitFairnessFrom(slots(agent(300_000))));
    expect(graded).toEqual({ verdict: "fail", detail: "done_too_late 2610s > 2010s (queue wait not credited: no createdAt for r0, so runs cannot be ordered)" });
  });

  it("credits the first executed carrier, never a run cancelled before it executed", () => {
    const { queuedAt } = shape();
    const fairness = queueWaitFairnessFrom(slots(agent()));
    const cancelled = (errorCode: string, started: boolean) => run("rc", "cancelled", queuedAt - 20, queuedAt - 10,
      { wakeCommentIds: ["c1"], errorCode, startedAt: started ? iso(queuedAt - 15) : null });
    const followUp = { at: T0 + queuedAt - 1_000, sentAt: T0 + queuedAt - 500, commentId: "c1", error: null };
    const runWakes = { r2: { wakeReason: "issue_commented", continuesRunIds: [] }, rc: { wakeReason: "issue_commented", continuesRunIds: [] } };
    for (const [errorCode, started] of [["continuation_task_ownership_changed", true], ["cancelled", false]] as const) {
      const task = followUpTask(2_310_000, 0, {}, {}, { stagingMix: {}, followUp, runWakes }, [cancelled(errorCode, started)]);
      expect(gradeR1(task, BUDGET, [], fairness)).toEqual({ verdict: "pass", detail: "done after 2310s (allowed 3568s incl. 1558s fair queue wait)" });
    }
  });

  it("refuses follow-up credit without wake evidence", () => {
    const graded = gradeR1(followUpTask(2_310_000, 0, {}, {}, { runWakes: undefined }), BUDGET, [], queueWaitFairnessFrom(slots(agent())));
    expect(graded).toEqual({ verdict: "fail", detail: "done_too_late 2310s > 2010s (queue wait not credited: no wake evidence for follow-up run r2)" });
  });

  it("credits only the part of a wait inside the task's own lifetime", () => {
    const graded = gradeR1(followUpTask(2_310_000, 0, {}, {}, { restAt: T0 + 2_100_000 }), BUDGET, [], queueWaitFairnessFrom(slots(agent())));
    expect(graded).toEqual({ verdict: "pass", detail: "done after 2100s (allowed 3444s incl. 1434s fair queue wait)" });
  });

  it("does not credit outage time inside the follow-up's wait", () => {
    const { queuedAt } = shape();
    const outage: FaultReceipt = { ...fault, startedAt: T0 + queuedAt + 100_000, readyAt: T0 + queuedAt + 200_000 };
    expect(gradeR1(followUpTask(2_500_000), BUDGET, [outage], queueWaitFairnessFrom(slots(agent()))))
      .toEqual({ verdict: "pass", detail: "done after 2500s (allowed 3568s incl. 1458s fair queue wait)" });
  });

  it("sums the fair waits of the first run and a follow-up", () => {
    const graded = gradeR1(followUpTask(2_610_000, 300_000), BUDGET, [], queueWaitFairnessFrom(slots(agent(300_000))));
    expect(graded).toEqual({ verdict: "pass", detail: "done after 2610s (allowed 3868s incl. 1858s fair queue wait)" });
    const tooLate = gradeR1(followUpTask(3_900_000, 300_000), BUDGET, [], queueWaitFairnessFrom(slots(agent(300_000))));
    expect(tooLate).toEqual({ verdict: "fail", detail: "done_too_late 3900s > 3868s incl. 1858s fair queue wait" });
  });
});

describe("T-oracles", () => {
  it("grades M1 delegation: two done subtasks, part 1 delegated, and a summary of both", () => {
    const agents = { self: { id: "self", name: "Chaos codex" }, other: { id: "other", name: "Chaos claude" } };
    const child = (n: number, assigneeAgentId: string, status = "done") =>
      ({ id: `c${n}`, status, assigneeAgentId, documents: { part: `PART${n}-abcd1234\nIdempotency keys.` } });
    const artifacts: OracleArtifacts = { issueStatus: "done", agentComments: [], files: {}, commands: {}, workspacePath: null,
      documents: { summary: "PART1-abcd1234\nPART2-abcd1234" }, children: [child(1, "other"), child(2, "self")] };
    expect(workloadDefinitions.M1.grade("abcd1234", artifacts, agents).verdict).toBe("pass");
    expect(workloadDefinitions.M1.description("abcd1234", agents)).toContain("assigned to Chaos claude");
    const undelegated = { ...artifacts, children: [child(1, "self"), child(2, "self")] };
    expect(workloadDefinitions.M1.grade("abcd1234", undelegated, agents).checks.find(check => check.name === "part1_delegated")?.ok).toBe(false);
    const pending = { ...artifacts, children: [child(1, "other", "in_progress"), child(2, "self")] };
    expect(workloadDefinitions.M1.grade("abcd1234", pending, agents).verdict).toBe("fail");
    expect(workloadDefinitions.M1.grade("abcd1234", { ...artifacts, children: [child(1, "other")] }, agents).verdict).toBe("fail");
    const both = { ...artifacts, children: [{ ...child(1, "other"), documents: { part: "PART1-abcd1234\nPART2-abcd1234" } },
      { ...child(2, "self"), documents: { part: "nothing" } }] };
    expect(workloadDefinitions.M1.grade("abcd1234", both, agents).checks.find(check => check.name === "parts_in_distinct_subtasks")?.ok).toBe(false);
    const wrongPart2 = { ...artifacts, children: [child(1, "other"), child(2, "other")] };
    expect(workloadDefinitions.M1.grade("abcd1234", wrongPart2, agents).checks.find(check => check.name === "part2_kept")?.ok).toBe(false);
    const single = { self: agents.self, other: agents.self };
    expect(workloadDefinitions.M1.grade("abcd1234", { ...artifacts, children: [child(1, "self"), child(2, "self")] }, single)
      .checks.find(check => check.name === "two_agents")?.ok).toBe(false);
  });

  it("grades A1 and C1 markers", () => {
    expect(workloadDefinitions.A1.grade("abcd1234", passingBrief).verdict).toBe("pass");
    expect(workloadDefinitions.C1.grade("abcd1234", passingBrief).checks.find(check => check.name.includes("followup"))?.ok).toBe(false);
    expect(workloadDefinitions.C1.grade("abcd1234", { ...passingBrief, documents: { brief: `${passingBrief.documents.brief}FOLLOWUP-abcd1234\n` } }).verdict).toBe("pass");
  });

  it("fails M1 when a subtask needed a board Retry, and checks the parent got one stall wake per stall", () => {
    const done = record([sample(1_000, "done", [run("r1", "succeeded", 0, 900)])], { finalStatus: "done" });
    const withChildRetry = { ...done, childRetries: [{ childIssueId: "c2", at: 1, observedRunId: "r", httpStatus: 200, accepted: true, error: null }] };
    expect(gradeR3(done)).toMatchObject({ verdict: "n/a" });
    expect(gradeR3(withChildRetry)).toMatchObject({ verdict: "fail", detail: "retry_needed_on_subtask_1 (c2)" });
    const stalled = { issueStatus: "done", documents: {}, agentComments: [], files: {}, commands: {}, workspacePath: null,
      childStalls: [{ childIssueId: "c2", recoveryActionId: "a1" }] };
    const wakeA1 = { stalledIssueId: "c2", recoveryActionId: "a1" };
    expect(stallWakeChecks({ ...stalled, stallWakes: [wakeA1] } as never)[0]).toMatchObject({ ok: true });
    expect(stallWakeChecks({ ...stalled, stallWakes: [] } as never)[0]).toMatchObject({ ok: false, detail: "stalls=1 wakes=0 unwoken=c2:a1" });
    expect(stallWakeChecks({ ...stalled, stallWakes: [wakeA1, wakeA1] } as never)[0]).toMatchObject({ ok: false });
    const twoStalls = { ...stalled, childStalls: [...stalled.childStalls, { childIssueId: "c2", recoveryActionId: "a2" }] };
    expect(stallWakeChecks({ ...twoStalls, stallWakes: [wakeA1] } as never)[0]).toMatchObject({ ok: false, detail: "stalls=2 wakes=1 unwoken=c2:a2" });
    expect(stallWakeChecks({ ...twoStalls, stallWakes: [wakeA1, { stalledIssueId: "c2", recoveryActionId: "a2" }] } as never)[0]).toMatchObject({ ok: true });
    expect(stallWakeChecks({ ...stalled, childStalls: [] } as never)).toEqual([]);
  });

  it("grades a Retry the user could not click in the board UI under its own R3 signature", () => {
    const record = { plan: { workload: "A1" }, launchError: null, finalStatus: "blocked", timedOut: false, createdAt: 0, restAt: 1,
      samples: [{ at: 1, reachable: true, serverReady: true, issueStatus: "blocked", interruption: { state: "failed", canRetry: true } }],
      retry: { at: 2, observedRunId: "r1", httpStatus: null, accepted: null, error: "ui_retry_button_missing", via: "ui", bannerText: "Saving files" } } as unknown as TaskRecord;
    expect(gradeR3(record)).toEqual({ verdict: "fail", detail: "ui_retry_button_missing (user saw: Saving files)" });
    expect(gradeR3({ ...record, retry: { ...record.retry!, clicked: true, error: "ui_retry_no_request" } } as TaskRecord).detail).toMatch(/^ui_retry_no_request/);
    expect(gradeR3({ ...record, retry: { ...record.retry!, error: "ui_retry_blocked_by_modal" } } as TaskRecord).detail)
      .toBe("ui_retry_blocked_by_modal (user saw: Saving files)");
  });

  it("reports R2 as not checked for a sandbox-only workspace instead of passing it", () => {
    const record = { plan: { workload: "R1" }, launchError: null, finalStatus: "done", timedOut: false, createdAt: 0, restAt: 1,
      remoteWorkspace: true, preFaultFiles: null, samples: [{ at: 1, reachable: true, serverReady: true, issueStatus: "done", interruption: null }] } as unknown as TaskRecord;
    expect(gradeR2(record, { verdict: "pass", checks: [] })).toEqual({ verdict: "n/a",
      detail: "remote workspace: files before and after the fault are not compared from this host" });
  });

  it("grades S1: stopped run cancelled, nothing ran before the continue comment, brief has both markers", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: { brief: "CHAOS-abcd1234\nCONTINUE-abcd1234\n- one\n- two\n- three\n" },
      agentComments: [], files: {}, commands: {}, workspacePath: null,
      stop: { runId: "r1", runStatus: "cancelled", runsStartedBeforeContinue: [], continuePosted: true } };
    expect(workloadDefinitions.S1.grade("abcd1234", base).verdict).toBe("pass");
    const restarted = workloadDefinitions.S1.grade("abcd1234", { ...base, stop: { ...base.stop!, runsStartedBeforeContinue: ["r2"] } });
    expect(restarted.checks.find(check => check.name === "nothing_ran_after_stop")).toMatchObject({ ok: false, detail: "continue=true runs=r2" });
    expect(workloadDefinitions.S1.grade("abcd1234", { ...base, stop: { ...base.stop!, runStatus: "succeeded" } }).verdict).toBe("fail");
    expect(workloadDefinitions.S1.grade("abcd1234", { ...base, stop: undefined }).verdict).toBe("fail");
    const missed = workloadDefinitions.S1.grade("abcd1234", { ...base, stop: { runId: null, runStatus: null, runsStartedBeforeContinue: [], continuePosted: true, missed: true } });
    expect(missed.verdict).toBe("pass");
    expect(missed.checks.find(check => check.name === "stop_took_effect")).toMatchObject({ ok: true, detail: "missed: the run finished before the stop window" });
    expect(workloadDefinitions.S1.grade("abcd1234", { ...base, documents: { brief: "CHAOS-abcd1234\n- one\n- two\n- three\n" },
      stop: { runId: null, runStatus: null, runsStartedBeforeContinue: [], continuePosted: true, missed: true } }).verdict).toBe("fail");
  });

  it("grades B1 by running the tests and the CLI", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: {}, agentComments: [], workspacePath: "/tmp/ws",
      files: { "NOTES-abcd1234.md": "B1-abcd1234\n" },
      commands: { unittest: { exitCode: 0, stdout: "", stderr: "OK" }, slugify: { exitCode: 0, stdout: "hello-chaos-world\n", stderr: "" } } };
    expect(workloadDefinitions.B1.grade("abcd1234", base).verdict).toBe("pass");
    expect(workloadDefinitions.B1.grade("abcd1234", { ...base, commands: { ...base.commands, unittest: { exitCode: 1, stdout: "", stderr: "FAILED" } } }).verdict).toBe("fail");
  });

  it("grades R1 by running the agent's node test and a hidden case against its module", () => {
    const base: OracleArtifacts = { issueStatus: "done", documents: {}, agentComments: [], workspacePath: "/tmp/ws",
      files: { "packages/shared/src/chaos/slug-abcd1234.ts": "export function chaosSlug() {}",
        "packages/shared/src/chaos/slug-abcd1234.test.ts": [
          "import test from \"node:test\";", "import assert from \"node:assert/strict\";", "import { chaosSlug } from \"./slug-abcd1234.ts\";",
          "test(\"slug\", () => {", "  assert.equal(chaosSlug(\"Hello Chaos World\"), \"hello-chaos-world\");",
          "  assert.equal(chaosSlug(\"a  b\"), \"a-b\");", "  assert.equal(chaosSlug(\"--x--\"), \"x\");", "});"].join("\n") },
      commands: { node_test: { exitCode: 0, stdout: "", stderr: "" },
        slug: { exitCode: 0, stdout: "[\"hello-chaos-world\",\"r1-paperclip-chaos-2026\"]\n", stderr: "" } } };
    expect(workloadDefinitions.R1.grade("abcd1234", base).verdict).toBe("pass");
    expect(workloadDefinitions.R1.grade("abcd1234", { ...base, commands: { ...base.commands,
      slug: { exitCode: 0, stdout: "[\"hello-chaos-world\",\"-r1-paperclip-chaos-2026-\"]\n", stderr: "" } } }).verdict).toBe("fail");
    expect(r1TestChecksSlug("import test from \"node:test\";")).toBe(false);
    expect(r1TestChecksSlug("import test from \"node:test\"; import assert from \"node:assert\"; assert.ok(chaosSlug(\"x\"));")).toBe(false);
    expect(r1TestChecksSlug([ "import test from \"node:test\";", "import assert from \"node:assert/strict\";",
      "for (const [input, want] of [[\"Hello Chaos World\", \"hello-chaos-world\"], [\"a b\", \"a-b\"], [\"-x-\", \"x\"]])",
      "  test(input, () => assert.equal(chaosSlug(input), want));"].join("\n"))).toBe(true);
    const argv = workloadDefinitions.R1.collect.commands.find(command => command.name === "node_test")!.argv;
    expect(typeof argv === "function" ? argv("abcd1234") : argv).toEqual([process.execPath, "--test", "packages/shared/src/chaos/slug-abcd1234.test.ts"]);
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
