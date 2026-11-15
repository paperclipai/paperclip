import { describe, expect, it } from "vitest";
import { gradeReleaseSwapTask, overlappingRuns, personReason, releaseSwapMarkdown, retryLabel, summarizeGrades, swapMetrics, type GradeTaskInput, type SwapRunFact } from "./release-swap-grade.js";
import { mergeRunSample, swapEvidence, type SwapRecord } from "./release-swap-driver.js";

const task = (overrides: Partial<GradeTaskInput> = {}): GradeTaskInput => ({
  issueId: "i1", identifier: "CHA-1", title: "t", status: "done", runs: [{ runId: "r1", status: "succeeded", errorCode: null, createdAt: 1, startedAt: 2, finishedAt: 3 }],
  queuedWakes: 0, scheduledRetry: false, interruption: null, activeRecoveryOwner: null, executionBlocker: false, openBlockers: 0,
  pendingApproval: false, pendingQuestion: false, retryClicks: [], ...overrides,
});
const failed = { runId: "r0", status: "failed", errorCode: "process_lost", createdAt: 0, startedAt: 0, finishedAt: 1 };
const interruption = (overrides: Partial<NonNullable<GradeTaskInput["interruption"]>> = {}) =>
  ({ state: "failed", canRetry: false, retryWait: false, userAction: null, providerFailureCategory: null, ...overrides });

describe("release swap task grade", () => {
  it("passes a task done with no person, even after a failed run the system recovered", () => {
    expect(gradeReleaseSwapTask(task()).verdict).toBe("pass");
    const recovered = gradeReleaseSwapTask(task({ runs: [failed, ...task().runs] }));
    expect(recovered).toMatchObject({ verdict: "pass", failedRuns: ["r0"] });
  });

  it("fails a task that needed Retry and says whether the click worked", () => {
    const worked = gradeReleaseSwapTask(task({ runs: [failed, { runId: "r2", status: "succeeded", errorCode: null, createdAt: 50, startedAt: 51, finishedAt: 60 }],
      retryClicks: [{ at: 40, accepted: true, via: "observer" }] }));
    expect(worked).toMatchObject({ verdict: "needed_retry", retry: { clicks: 1, accepted: 1, worked: true } });
    const refused = gradeReleaseSwapTask(task({ status: "todo", runs: [failed], retryClicks: [{ at: 40, accepted: false, via: "grader" }] }));
    expect(refused.retry).toEqual({ clicks: 1, accepted: 0, worked: false });
    const running = gradeReleaseSwapTask(task({ status: "in_progress", runs: [failed, { runId: "r3", status: "running", errorCode: null, createdAt: 50, startedAt: 51, finishedAt: null }],
      retryClicks: [{ at: 40, accepted: true, via: "grader" }] }));
    expect(running.retry?.worked).toBeNull();
    const stuck = gradeReleaseSwapTask(task({ status: "todo", runs: [failed, { runId: "r4", status: "failed", errorCode: "x", createdAt: 50, startedAt: 51, finishedAt: 52 }],
      retryClicks: [{ at: 40, accepted: true, via: "grader" }] }));
    expect(stuck.retry?.worked).toBe(false);
  });

  it("fails an open task with no live run, no queued wake and no named reason", () => {
    expect(gradeReleaseSwapTask(task({ status: "in_progress", runs: [failed] })).verdict).toBe("open_no_owner");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed] })).verdict).toBe("open_no_owner");
  });

  it("keeps a task with a live run, a queued wake or a system retry as still working, not passed", () => {
    expect(gradeReleaseSwapTask(task({ status: "in_progress", runs: [{ ...failed, status: "queued" }] })).verdict).toBe("still_working");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed], queuedWakes: 1 })).verdict).toBe("still_working");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed], interruption: interruption({ state: "retry_scheduled" }) })).verdict).toBe("still_working");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed], activeRecoveryOwner: "agent" })).verdict).toBe("still_working");
  });

  it("fails a task blocked for a reason that is not a person's", () => {
    const confirm = gradeReleaseSwapTask(task({ status: "blocked", runs: [failed], interruption: interruption({ state: "waiting_for_user", userAction: "confirm_run_stopped" }) }));
    expect(confirm).toMatchObject({ verdict: "blocked_non_person", personReason: null });
    expect(confirm.detail).toContain("confirm_run_stopped");
    expect(gradeReleaseSwapTask(task({ status: "blocked", runs: [failed] })).verdict).toBe("blocked_non_person");
    expect(gradeReleaseSwapTask(task({ status: "in_progress", runs: [failed], executionBlocker: true })).verdict).toBe("blocked_non_person");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed], activeRecoveryOwner: "board" })).verdict).toBe("blocked_non_person");
  });

  it("names a person's reason and grades the wait apart from the failures", () => {
    const cases: Array<[Partial<GradeTaskInput>, string]> = [
      [{ interruption: interruption({ state: "waiting_for_user", userAction: "approval" }) }, "approval"],
      [{ pendingApproval: true }, "approval"],
      [{ pendingQuestion: true }, "question"],
      [{ openBlockers: 1 }, "dependency"],
      [{ status: "in_review" }, "review"],
      [{ interruption: interruption({ providerFailureCategory: "rate_limit" }) }, "usage_limit"],
      [{ interruption: interruption({ state: "waiting_for_user", userAction: "budget" }) }, "budget"],
      [{ interruption: interruption({ state: "waiting_for_user", userAction: "reconnect" }) }, "shared_credential"],
    ];
    for (const [overrides, reason] of cases) {
      const input = task({ status: "blocked", runs: [failed], ...overrides });
      expect(personReason(input)).toBe(reason);
      expect(gradeReleaseSwapTask(input).verdict).toBe("waiting_on_person");
    }
  });

  it("names a user-responsibility wait that is not a grade person reason and counts it by reason", () => {
    const model = gradeReleaseSwapTask(task({ status: "blocked", runs: [failed],
      interruption: interruption({ state: "waiting_for_user", userAction: "choose_model", responsibility: "user" }) }));
    expect(model).toMatchObject({ verdict: "blocked_non_person", personReason: null, reason: "user action choose_model" });
    expect(model.detail).toContain("not one of the grade's person reasons");
    const question = gradeReleaseSwapTask(task({ status: "blocked", runs: [failed], pendingQuestion: true }));
    expect(summarizeGrades([model, question, gradeReleaseSwapTask(task())]).byReason)
      .toEqual({ "blocked_non_person: user action choose_model": 1, "waiting_on_person: question": 1 });
  });

  it("labels every failing task with exactly one of the three reported labels", () => {
    const grades = [
      gradeReleaseSwapTask(task({ status: "todo", runs: [failed] })),
      gradeReleaseSwapTask(task({ status: "blocked", runs: [failed] })),
      gradeReleaseSwapTask(task({ runs: [failed, { runId: "r2", status: "succeeded", errorCode: null, createdAt: 50, startedAt: 51, finishedAt: 60 }], retryClicks: [{ at: 40, accepted: true, via: "grader" }] })),
      gradeReleaseSwapTask(task({ status: "todo", runs: [failed], retryClicks: [{ at: 40, accepted: false, via: "grader" }] })),
      gradeReleaseSwapTask(task({ status: "cancelled", runs: [failed] })),
    ];
    expect(grades.map(retryLabel)).toEqual(["nothing pending", "blocked for a non-person reason", "needed Retry (click worked)",
      "needed Retry (click did not work)", "nothing pending"]);
    expect(retryLabel(gradeReleaseSwapTask(task()))).toBeNull();
    expect(summarizeGrades(grades).byLabel).toEqual({ "nothing pending": 2, "blocked for a non-person reason": 1,
      "needed Retry (click worked)": 1, "needed Retry (click did not work)": 1 });
  });

  it("does not count a run with no activity for the settle period as a live owner", () => {
    const stuck = task({ status: "in_progress", now: 2_000_000, staleAfterMs: 900_000, interruption: interruption({ state: "working" }),
      runs: [{ runId: "r9", status: "running", errorCode: null, createdAt: 0, startedAt: 1, finishedAt: null, lastActivityAt: 1_000_000 }] });
    const grade = gradeReleaseSwapTask(stuck);
    expect(grade).toMatchObject({ verdict: "open_no_owner", label: "nothing pending" });
    expect(grade.detail).toContain("run r9 running with no activity for 17 min");
    expect(gradeReleaseSwapTask({ ...stuck, runs: [{ ...stuck.runs[0]!, lastActivityAt: 1_500_000 }] }).verdict).toBe("still_working");
    const retry = gradeReleaseSwapTask({ ...stuck, scheduledRetry: true, runs: [failed, { ...stuck.runs[0]!, status: "queued" }] });
    expect(retry).toMatchObject({ verdict: "open_no_owner", label: "nothing pending" });
    expect(gradeReleaseSwapTask({ ...stuck, scheduledRetry: true, runs: [failed] }).verdict).toBe("open_no_owner");
  });

  it("reports an accepted Retry as pending while its scheduled retry is not yet due, and as not working once it is past due", () => {
    const now = 10_000_000;
    const base = { status: "todo", now, staleAfterMs: 300_000, runs: [failed], scheduledRetry: true, retryClicks: [{ at: 5, accepted: true, via: "grader" as const }] };
    expect(gradeReleaseSwapTask(task({ ...base, scheduledRetryAt: now + 60_000 })).retry?.worked).toBeNull();
    expect(gradeReleaseSwapTask(task({ ...base, scheduledRetryAt: now - 60_000 })).retry?.worked).toBe(false);
    expect(gradeReleaseSwapTask(task({ ...base, scheduledRetry: false, queuedWakes: 1 })).retry?.worked).toBeNull();
  });

  it("uses one staleness threshold after the drain: a 6-minute-silent run or a queued wake alone is nothing pending", () => {
    const now = 10_000_000;
    const silent = gradeReleaseSwapTask(task({ status: "in_progress", now, staleAfterMs: 300_000,
      runs: [{ runId: "r6", status: "running", errorCode: null, createdAt: 0, startedAt: 1, finishedAt: null, lastActivityAt: now - 360_000 }] }));
    expect(silent).toMatchObject({ verdict: "open_no_owner", label: "nothing pending", lastActivityAgeMs: null });
    expect(silent.detail).toContain("run r6 running with no activity for 6 min");
    const wake = gradeReleaseSwapTask(task({ status: "todo", now, staleAfterMs: 300_000, runs: [failed], queuedWakes: 1 }));
    expect(wake).toMatchObject({ verdict: "open_no_owner", label: "nothing pending" });
    expect(wake.detail).toContain("1 queued wake(s) never dispatched");
    expect(gradeReleaseSwapTask(task({ status: "todo", runs: [failed], queuedWakes: 1 })).verdict).toBe("still_working");
  });

  it("keeps a task still running past the drain cap out of the number and reports it with its last activity", () => {
    const running = gradeReleaseSwapTask(task({ status: "in_progress", now: 1_000_000, staleAfterMs: 900_000,
      runs: [{ runId: "r5", status: "running", errorCode: null, createdAt: 0, startedAt: 1, finishedAt: null, lastActivityAt: 940_000 }] }));
    expect(running).toMatchObject({ verdict: "still_working", lastActivityAgeMs: 60_000, label: null });
    expect(running.detail).toContain("last activity 60 s ago");
    expect(summarizeGrades([gradeReleaseSwapTask(task()), running], 0, "cap")).toMatchObject({ started: 1, stillRunning: 1, drainReason: "cap",
      headline: "1 / 1 tasks completed without human action; 1 still running at the drain cap, not counted (last activity 60 s ago)" });
  });

  it("says the number is incomplete when task views could not be read", () => {
    expect(summarizeGrades([gradeReleaseSwapTask(task())], 2)).toMatchObject({ uncollected: 2,
      headline: "1 / 1 tasks completed without human action (incomplete: 2 task(s) could not be read and are not counted)" });
  });

  it("publishes one number: tasks completed without human action over tasks started", () => {
    const grades = [task(), task({ issueId: "i2" }), task({ issueId: "i3", status: "todo", runs: [failed] }),
      task({ issueId: "i4", runs: [failed], retryClicks: [{ at: 0, accepted: true, via: "grader" }] })].map(gradeReleaseSwapTask);
    const result = summarizeGrades(grades);
    expect(result.headline).toBe("2 / 4 tasks completed without human action");
    expect(result.byVerdict).toMatchObject({ pass: 2, open_no_owner: 1, needed_retry: 1 });
    const markdown = releaseSwapMarkdown(result, [], [], { overlappingRuns: [], doubleExecutors: [], duplicateComments: [], duplicateChildren: [] }, grades);
    expect(markdown.split("\n")[0]).toBe("2 / 4 tasks completed without human action");
  });
});

describe("release swap per-swap numbers", () => {
  const swaps = [
    { index: 1, requestedAt: 1_000, spawnedAt: 1_100, stopRequestedAt: 2_000, stoppedAt: 2_100, fromPid: 10 },
    { index: 2, requestedAt: 5_000, spawnedAt: 5_100, stopRequestedAt: 6_000, stoppedAt: 6_100, fromPid: 11 },
  ];
  const fact = (overrides: Partial<SwapRunFact>): SwapRunFact => ({ runId: "r", issueId: "i", status: "succeeded", errorCode: null, startedAt: 0, finishedAt: null, ownerPidBeforeEnd: null, ...overrides });

  it("counts failed runs per swap, runs lost while the old server lived, and the gap to each survivor's next event", () => {
    const runs = [
      fact({ runId: "lost", status: "failed", errorCode: "process_lost", startedAt: 500, finishedAt: 1_500, ownerPidBeforeEnd: 10 }),
      fact({ runId: "shutdown", status: "failed", errorCode: "server_shutdown_interrupted", startedAt: 500, finishedAt: 2_050, ownerPidBeforeEnd: 10 }),
      fact({ runId: "late", status: "failed", errorCode: "controller_lease_lost", startedAt: 5_500, finishedAt: 7_000, ownerPidBeforeEnd: 11 }),
      fact({ runId: "survivor", status: "succeeded", startedAt: 1_900, finishedAt: 6_500 }),
      fact({ runId: "quiet", status: "running", startedAt: 1_950, finishedAt: null }),
    ];
    const events = new Map([["1:survivor", 2_400], ["2:survivor", 6_300]]);
    const [first, second] = swapMetrics(swaps, runs, events, 9_000);
    expect(first).toMatchObject({ failedRuns: ["lost", "shutdown"], lostWhileOldAlive: ["lost"], nextEventP50Ms: 400, nextEventMaxMs: 400, survivorsWithoutEvent: 1 });
    expect(first!.survivors.map(survivor => survivor.runId)).toEqual(["survivor", "quiet"]);
    expect(second).toMatchObject({ failedRuns: ["late"], lostWhileOldAlive: [], nextEventP50Ms: 300 });
  });

  it("finds a run nested inside a long earlier run, not only neighbours", () => {
    expect(overlappingRuns([fact({ runId: "A", startedAt: 0, finishedAt: 100 }), fact({ runId: "B", startedAt: 10, finishedAt: 20 }),
      fact({ runId: "C", startedAt: 30, finishedAt: 50 })], 1_000)).toEqual([{ issueId: "i", runIds: ["A", "B"] }, { issueId: "i", runIds: ["A", "C"] }]);
  });

  it("finds two runs of one task executing at once", () => {
    expect(overlappingRuns([fact({ runId: "a", startedAt: 0, finishedAt: 100 }), fact({ runId: "b", startedAt: 50, finishedAt: 200 }),
      fact({ runId: "c", startedAt: 200, finishedAt: 300 }), fact({ runId: "d", issueId: "other", startedAt: 0, finishedAt: null })], 1_000))
      .toEqual([{ issueId: "i", runIds: ["a", "b"] }]);
  });
});

describe("release swap overlap evidence", () => {
  const swap = (): SwapRecord => ({ index: 1, faultId: "f01", fromPid: 10, toPid: 20, fromUrl: "a", toUrl: "b", serverRoot: null, requestedAt: 0,
    spawnedAt: 100, switchedAt: 3_000, overlapEndsAt: 93_000, stopRequestedAt: 93_000, stoppedAt: 95_000,
    incomingPhases: [{ phase: "starting", at: 500 }, { phase: "recovering", at: 2_000 }, { phase: "ready", at: 2_600 }],
    probes: [{ kind: "prep", adapter: "codex", nonce: "n", requestedAt: 100, createdAt: 200, issueId: "prep", identifier: null, error: null },
      { kind: "late", adapter: "codex", nonce: "m", requestedAt: 60_000, createdAt: 60_100, issueId: "late", identifier: "CHA-9", error: null }],
    runs: {}, sampleErrors: 0, plugins: [], abandoned: null, evidence: null });
  const row = (runId: string, issueId: string, at: number, status: string, ownerPid: number | null, executionStage: string | null, startedAt: number) =>
    ({ runId, issueId, createdAt: startedAt, startedAt, finishedAt: null, errorCode: null, at, status, ownerPid, executionStage, nativePhase: null, lastOutputSeq: 0 });

  it("proves the old server started a run about 20 s before its SIGTERM and had one preparing during the new server's recovery", () => {
    const record = swap();
    for (const sample of [row("p1", "prep", 1_000, "running", 10, "preparing", 900), row("p1", "prep", 2_400, "running", 10, "preparing", 900),
      row("p1", "prep", 4_000, "running", 10, "executing", 900), row("l1", "late", 74_000, "running", 10, "preparing", 73_500)]) mergeRunSample(record.runs, sample);
    const evidence = swapEvidence(record);
    expect(evidence).toMatchObject({ lateRunId: "l1", lateStartedBy: "old", lateStartOffsetMs: -19_500, lateOk: true, prepRunIds: ["p1"], prepOk: true,
      startedByOld: ["p1", "l1"], startedByNew: [], findings: [] });
  });

  it("does not count the incoming server's boot as its recovery pass when no recovering phase was seen", () => {
    const record = { ...swap(), incomingPhases: [{ phase: "starting", at: 500 }, { phase: "ready", at: 2_600 }] };
    mergeRunSample(record.runs, row("p1", "prep", 1_000, "running", 10, "preparing", 900));
    const evidence = swapEvidence(record);
    expect(evidence).toMatchObject({ recoveryWindow: null, prepOk: false });
    expect(evidence.findings).toContain("the incoming server's startup recovery pass was not observed (no `recovering` phase before `ready`)");
  });

  it("reports a finding instead of a pass when the new server took the runs", () => {
    const record = swap();
    for (const sample of [row("p1", "prep", 1_000, "running", 20, "preparing", 900), row("l1", "late", 74_000, "running", 20, "preparing", 73_500)]) mergeRunSample(record.runs, sample);
    const evidence = swapEvidence(record);
    expect(evidence).toMatchObject({ lateOk: false, prepOk: false, startedByNew: ["p1", "l1"] });
    expect(evidence.findings).toEqual(["late probe run l1 was started by the new server",
      "no run of the outgoing server was seen in preparation during the incoming server's startup recovery"]);
  });
});
