import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { collectStagingMixArtifacts, doneMarker, expectedRoundHash, gradeStagingMix, planStagingMixWave, ROUND_SECONDS, type StagingMixTask } from "./staging-mix.js";
import {
  bannerSink, issueView, readAssignedWorkInvariant, retryAfterSettleStage, shouldClickRetryAfterSettle, stagingMixHeadline, summarizeStagingMix,
  type RetryStageObserver,
} from "./staging-mix-retry.js";
import type { OracleArtifacts, TaskPlan, TaskRecord, TaskSample } from "./types.js";

const wave = (argv: string[]) => {
  const command = parseCommand(argv);
  if (command.mode !== "wave") throw new Error("expected a wave");
  return command.options;
};

const task = (overrides: Partial<StagingMixTask> = {}): StagingMixTask => ({
  turnMinutes: 5, rounds: 4, subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 600_000, ...overrides,
});

const ledger = (nonce: string, rounds: number) => Array.from({ length: rounds }, (_, index) =>
  `ROUND ${index + 1} ${1_800_000_000 + index * 100} ${1_800_000_000 + index * 100 + ROUND_SECONDS} ${expectedRoundHash(nonce, index + 1)}`).join("\n");

describe("staging-mix Retry policy", () => {
  it("is hands-off by default, and keeps the overlap Retry only behind --mix-retry-during-wave", () => {
    const base = ["--workload", "staging-mix", "--faults", "K0", "--mix-turn-minutes", "5-15", "--mix-minutes", "40"];
    const handsOff = wave(base);
    expect(handsOff.stagingMix).toMatchObject({ retryDuringWave: false, settleMinutes: 15 });
    expect(planStagingMixWave("w", handsOff).tasks.every(entry => entry.stagingMix!.retryDuringWave === undefined)).toBe(true);
    const old = wave([...base, "--mix-retry-during-wave", "--mix-settle-minutes", "5"]);
    expect(old.stagingMix).toMatchObject({ retryDuringWave: true, settleMinutes: 5 });
    expect(planStagingMixWave("w", old).tasks.every(entry => entry.stagingMix!.retryDuringWave === true)).toBe(true);
  });

  it("clicks once after the settle, only on a task still offering Retry that nobody clicked and that has no retry scheduled", () => {
    const view = (overrides: Partial<ReturnType<typeof issueView>> = {}) => ({ status: "blocked", canRetry: true, retryWait: false, retryScheduled: false, ...overrides });
    expect(shouldClickRetryAfterSettle(view(), 0)).toBe(true);
    expect(shouldClickRetryAfterSettle(view(), 1)).toBe(false);
    expect(shouldClickRetryAfterSettle(view({ status: "done" }), 0)).toBe(false);
    expect(shouldClickRetryAfterSettle(view({ retryWait: true }), 0)).toBe(false);
    expect(shouldClickRetryAfterSettle(view({ canRetry: false }), 0)).toBe(false);
    expect(shouldClickRetryAfterSettle(view({ retryScheduled: true }), 0)).toBe(false);
    const scheduled = issueView({ status: "in_progress", interruption: { state: "retry_scheduled", canRetry: true, nextRetryAt: "2026-11-12T20:00:00Z" } });
    expect(scheduled.retryScheduled).toBe(true);
    expect(shouldClickRetryAfterSettle(scheduled, 0)).toBe(false);
    expect(issueView({ status: "blocked", scheduledRetry: { scheduledRetryAt: "x" }, interruption: { state: "failed", canRetry: true } }).retryScheduled).toBe(true);
    expect(issueView({ status: "blocked", interruption: { state: "failed", canRetry: true } }).retryScheduled).toBe(false);
  });

  const harness = () => {
    let clock = 0;
    const issues: Record<string, Record<string, unknown>> = {};
    const observer = (taskId: string, issueId: string, overrides: Partial<TaskRecord> = {}, finishAfterClickMs = 0) => {
      const self = {
        plan: { taskId, stagingMix: task() } as TaskPlan, record: { issueId, retry: null, finalStatus: "blocked", ...overrides } as TaskRecord, done: true,
        clicks: 0, reopened: 0, clickedAt: null as number | null,
        async poll() {
          if (issues[issueId]!.status === "done" || (self.clickedAt !== null && clock - self.clickedAt >= finishAfterClickMs)) { issues[issueId] = { status: "done" }; self.done = true; }
        },
        reopen() { self.done = false; self.reopened += 1; },
        async retryAfterSettle(sample: TaskSample, at: number) {
          self.done = false; self.clicks += 1; self.clickedAt = at;
          expect(sample.interruption?.observedRunId).toBe(`r${issueId.slice(1)}`);
          self.record.retry = { at, accepted: true } as TaskRecord["retry"];
        },
      };
      return self satisfies RetryStageObserver;
    };
    return { issues, observer, now: () => clock, advance: (ms: number) => { clock += ms; } };
  };

  it("waits out the settle hands-off, refreshes a task that healed, clicks once per stuck task and follows it on the retry budget", async () => {
    const h = harness();
    const failed = (id: string) => ({ status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: `r${id}` } });
    Object.assign(h.issues, { i1: failed("1"), i2: failed("2"), i3: failed("3"), i4: { status: "in_progress", interruption: { state: "retry_scheduled", canRetry: true } } });
    const healsItself = h.observer("t1", "i1"), stuck = h.observer("t2", "i2", {}, 10 * 60_000);
    const alreadyClicked = h.observer("t3", "i3", { retry: { at: 1, accepted: true } as TaskRecord["retry"] }), scheduled = h.observer("t4", "i4");
    const notes: string[] = [];
    const result = await retryAfterSettleStage({ observers: [healsItself, stuck, alreadyClicked, scheduled],
      api: { get: async <T>(path: string) => h.issues[path.split("/").pop()!] as T }, settleUntil: 120_000, cancelled: () => false,
      note: kind => notes.push(kind), pollMs: 60_000, now: h.now, sleep: async ms => { h.advance(ms); if (h.now() >= 60_000) h.issues.i1 = { status: "done" }; } });
    expect(result).toEqual({ clicked: ["t2"], refreshed: ["t1"] });
    expect([healsItself.clicks, stuck.clicks, alreadyClicked.clicks, scheduled.clicks]).toEqual([0, 1, 0, 0]);
    expect(healsItself.reopened).toBe(1);
    expect([healsItself.done, stuck.done]).toEqual([true, true]);
    expect(healsItself.record.stagingMix!.retryBanner).toMatchObject({ firstShownAt: 0, shownMs: 60_000 });
    expect(stuck.record.stagingMix!.retryAfterSettle).toMatchObject({ accepted: true, issueStatusAtClick: "blocked" });
    expect(notes).toEqual(["staging_mix_settling", "staging_mix_retry_after_settle", "staging_mix_refreshed_after_settle"]);
  });

  it("follows a click on the retry budget even with a zero settle", async () => {
    const h = harness();
    h.issues.i2 = { status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r2" } };
    const slow = h.observer("t2", "i2", {}, 12 * 60_000);
    await retryAfterSettleStage({ observers: [slow], api: { get: async <T>(path: string) => h.issues[path.split("/").pop()!] as T }, settleUntil: 0,
      cancelled: () => false, note: () => undefined, now: h.now, sleep: async ms => { h.advance(ms); } });
    expect(slow.clicks).toBe(1);
    expect(slow.done).toBe(true);
    expect(h.now()).toBeGreaterThanOrEqual(12 * 60_000);
  });

  it("feeds the swap grader's reads into banner tracking", () => {
    const record = { issueId: "i1" } as TaskRecord;
    const other = { issueId: "i9" } as TaskRecord;
    const sink = bannerSink([{ plan: { stagingMix: task() } as TaskPlan, record }, { plan: {} as TaskPlan, record: other }]);
    sink("i1", { status: "blocked", interruption: { canRetry: true } }, 1_000);
    sink("i1", { status: "unreadable" }, 2_000);
    sink("i1", { status: "in_progress", interruption: null }, 31_000);
    sink("i9", { status: "blocked", interruption: { canRetry: true } }, 1_000);
    expect(record.stagingMix!.retryBanner).toMatchObject({ firstShownAt: 1_000, shownMs: 30_000, visibleSince: null });
    expect(other.stagingMix).toBeUndefined();
  });

  it("counts done tasks with a verified deliverable and no click, and reports duplicates on their own line", () => {
    const record = (overrides: Partial<TaskRecord> = {}) => ({ issueId: null, retry: null, ...overrides }) as TaskRecord;
    const banner = { firstShownAt: 0, lastShownAt: 30_000, shownMs: 30_000, visibleSince: null, errorCode: "controller_lease_lost" };
    const ok = (name: string) => ({ name, ok: true }), bad = (name: string) => ({ name, ok: false });
    const clean = [ok("issue_done"), ok("ledger_rounds_verified"), ok("done_comment_posted"), ok("rounds_once"), ok("completion_once")];
    const result = summarizeStagingMix([
      { taskId: "t1", issueId: "i1", record: record({ finalStatus: "blocked", timedOut: true }), finalStatus: "done", checks: clean },
      { taskId: "t2", issueId: "i2", record: record({ stagingMix: { retryBanner: banner } }), finalStatus: "done", checks: [...clean.slice(0, 4), bad("completion_once")] },
      { taskId: "t3", issueId: "i3", record: record({ retry: { at: 1, accepted: true } as TaskRecord["retry"], stagingMix: { retryBanner: banner } }), finalStatus: "done", checks: clean },
      { taskId: "t4", issueId: "i4", record: record({ stagingMix: { retryBanner: banner } }), finalStatus: "blocked", checks: [bad("issue_done")] },
      { taskId: "t5", issueId: "i5", record: record(), finalStatus: "done", checks: [ok("issue_done"), bad("ledger_rounds_verified")] },
      { taskId: "t6", issueId: "i6", record: record(), finalStatus: "done", checks: null },
    ], new Set(["i4"]), { violationCount: 2, violations: { nothing_pending: 2 }, agentsWithStalledSlots: 1, openTasks: 3 }, 60_000);
    expect(stagingMixHeadline(result)).toEqual([
      "completed hands-off / started: 2 / 6",
      "duplicated side effects: 1 tasks",
      "Retry banner shown: 3 tasks",
      "Retry worked / Retry clicked: 1 / 2",
    ]);
    expect(result.duplicatedSideEffects).toEqual([{ taskId: "t2", checks: ["completion_once"] }]);
    expect(result.evidenceIncomplete).toEqual([]);
    expect(result.bannerShown.find(entry => entry.taskId === "t2")).toMatchObject({ completedAnyway: true, errorCode: "controller_lease_lost", shownMs: 30_000 });
    expect(result.invariant.violationCount).toBe(2);
  });

  it("keeps an unreadable completion check out of the confirmed duplicates and says the evidence is incomplete", () => {
    const record = { issueId: null, retry: null } as TaskRecord;
    const checks = [{ name: "issue_done", ok: true }, { name: "ledger_rounds_verified", ok: true }, { name: "done_comment_posted", ok: true },
      { name: "completion_once", ok: false, detail: "unreadable: the task's comments could not be read" }];
    const result = summarizeStagingMix([{ taskId: "t1", issueId: "i1", record, finalStatus: "done", checks },
      { taskId: "t2", issueId: "i2", record, finalStatus: "done", checks: [...checks.slice(0, 3), { name: "completion_once", ok: false, detail: "duplicate completion: runs a, b each reported completion" }] }],
    new Set(), { violationCount: 0, violations: {}, agentsWithStalledSlots: 0, openTasks: 0 });
    expect(result.duplicatedSideEffects).toEqual([{ taskId: "t2", checks: ["completion_once"] }]);
    expect(result.evidenceIncomplete).toEqual([{ taskId: "t1", checks: ["completion_once"] }]);
    expect(result.completedHandsOff).toBe(2);
    expect(stagingMixHeadline(result)[1]).toBe("duplicated side effects: 1 tasks; evidence incomplete: 1 tasks");
  });

  it("reads the assigned-work invariant once as counts, and records a failed read", async () => {
    const report = { checked: 4, openTasks: 3, violations: { nothing_pending: 1 }, violationCount: 1, agentsWithStalledSlots: [{ agentId: "a" }] };
    expect(await readAssignedWorkInvariant({ get: async <T>() => report as T }, "c1"))
      .toEqual({ violationCount: 1, violations: { nothing_pending: 1 }, agentsWithStalledSlots: 1, openTasks: 3 });
    expect(await readAssignedWorkInvariant({ get: async () => { throw new Error("HTTP 404"); } }, "c1")).toMatchObject({ violationCount: null, error: "Error: HTTP 404" });
  });
});

describe("staging-mix completion comments", () => {
  const nonce = "b3d70e77";
  const base = (comments: Array<{ body: string; runId: string | null }>): OracleArtifacts => ({ issueStatus: "done", documents: { ledger: ledger(nonce, 4) },
    agentComments: comments.map(comment => comment.body), files: {}, commands: {}, workspacePath: null,
    stagingMix: collectStagingMixArtifacts({} as TaskRecord, comments.map(comment => ({ body: comment.body, authorAgentId: "a", createdByRunId: comment.runId }))) });
  const check = (artifacts: OracleArtifacts, name: string) => gradeStagingMix(nonce, task(), artifacts).checks.find(entry => entry.name === name)!;

  it("counts only the DONE comment itself, not a closing summary that quotes it", () => {
    const comments = [
      { body: `CHA-1 complete. Saved the ledger and posted \`${doneMarker(nonce)}\`.`, runId: "run-b" },
      { body: "Prepared CHA-1 ledger for this response.", runId: "run-b" },
      { body: doneMarker(nonce), runId: "run-b" },
    ];
    expect(check(base(comments), "done_comment_once")).toMatchObject({ ok: true, detail: "comments=1" });
    expect(check(base(comments), "completion_once").ok).toBe(true);
    expect(gradeStagingMix(nonce, task(), base(comments)).verdict).toBe("pass");
    expect(check(base([...comments, { body: ` \`${doneMarker(nonce)}\`. `, runId: "run-c" }]), "done_comment_once")).toMatchObject({ ok: false, detail: "comments=2" });
    expect(check(base(comments.slice(0, 2)), "done_comment_posted")).toMatchObject({ ok: false, detail: "comments=0" });
  });

  it("marks completion_once unreadable instead of passing when the comments read failed", () => {
    const unread: OracleArtifacts = { ...base([{ body: doneMarker(nonce), runId: "run-b" }]), stagingMix: collectStagingMixArtifacts({} as TaskRecord, null) };
    expect(check(unread, "completion_once")).toMatchObject({ ok: false, detail: "unreadable: the task's comments could not be read" });
    expect(check(unread, "done_comment_posted").ok).toBe(true);
  });

  it("flags a completion summary repeated by a different run as a duplicate completion", () => {
    const comments = [
      { body: `CHA-1 complete. Posted exactly one comment ${doneMarker(nonce)} and marked the task done.`, runId: "413ddcf2-ffce" },
      { body: `CHA-1 complete. Posted \`${doneMarker(nonce)}\`.`, runId: "13de31be-fb13" },
      { body: doneMarker(nonce), runId: "13de31be-fb13" },
    ];
    expect(check(base(comments), "done_comment_once").ok).toBe(true);
    expect(check(base(comments), "completion_once")).toMatchObject({ ok: false, detail: "duplicate completion: runs 413ddcf2, 13de31be each reported completion" });
  });
});
