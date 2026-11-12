import { describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { doneMarker, expectedRoundHash, gradeStagingMix, planStagingMixWave, ROUND_SECONDS, type StagingMixTask } from "./staging-mix.js";
import {
  readAssignedWorkInvariant, retryAfterSettleStage, shouldClickRetryAfterSettle, stagingMixHeadline, summarizeStagingMix, type RetryStageObserver,
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

  it("clicks once after the settle, only on a task still offering Retry that nobody clicked", () => {
    expect(shouldClickRetryAfterSettle({ status: "blocked", canRetry: true, retryWait: false }, 0)).toBe(true);
    expect(shouldClickRetryAfterSettle({ status: "blocked", canRetry: true, retryWait: false }, 1)).toBe(false);
    expect(shouldClickRetryAfterSettle({ status: "done", canRetry: true, retryWait: false }, 0)).toBe(false);
    expect(shouldClickRetryAfterSettle({ status: "blocked", canRetry: true, retryWait: true }, 0)).toBe(false);
    expect(shouldClickRetryAfterSettle({ status: "in_progress", canRetry: false, retryWait: false }, 0)).toBe(false);
  });

  it("waits out the settle hands-off, then clicks once per stuck task and follows it to rest", async () => {
    let clock = 0;
    const issues: Record<string, Record<string, unknown>> = {
      i1: { status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r1" } },
      i2: { status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r2" } },
      i3: { status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r3" } },
    };
    const observer = (taskId: string, issueId: string, retry: TaskRecord["retry"] = null): RetryStageObserver & { clicks: number } => {
      const self = {
        plan: { taskId, stagingMix: task() } as TaskPlan, record: { issueId, retry } as TaskRecord, done: true, clicks: 0,
        async poll() { if (issues[issueId]!.status === "done") self.done = true; },
        async retryAfterSettle(sample: TaskSample, at: number) {
          self.done = false; self.clicks += 1;
          expect(sample.interruption?.observedRunId).toBe(`r${issueId.slice(1)}`);
          self.record.retry = { at, accepted: true } as TaskRecord["retry"];
          issues[issueId] = { status: "done" };
        },
      };
      return self;
    };
    const healsItself = observer("t1", "i1"), stuck = observer("t2", "i2"), alreadyClicked = observer("t3", "i3", { at: 1, accepted: true } as TaskRecord["retry"]);
    const notes: string[] = [];
    const result = await retryAfterSettleStage({ observers: [healsItself, stuck, alreadyClicked], api: { get: async <T>(path: string) => issues[path.split("/").pop()!] as T },
      settleUntil: 120_000, settleMs: 60_000, cancelled: () => false, note: kind => notes.push(kind), pollMs: 60_000, now: () => clock,
      sleep: async ms => { clock += ms; if (clock >= 60_000) issues.i1 = { status: "done" }; } });
    expect(clock).toBeGreaterThanOrEqual(120_000);
    expect(result.clicked).toEqual(["t2"]);
    expect([healsItself.clicks, stuck.clicks, alreadyClicked.clicks]).toEqual([0, 1, 0]);
    expect(stuck.done).toBe(true);
    expect(healsItself.record.stagingMix!.retryBanner).toMatchObject({ firstShownAt: 0, shownMs: 60_000 });
    expect(stuck.record.stagingMix!.retryAfterSettle).toMatchObject({ accepted: true, issueStatusAtClick: "blocked" });
    expect(notes).toEqual(["staging_mix_settling", "staging_mix_retry_after_settle"]);
  });

  it("reports the three numbers first, counting the swap grader's own clicks and banners that healed by themselves", () => {
    const record = (overrides: Partial<TaskRecord> = {}) => ({ issueId: null, retry: null, ...overrides }) as TaskRecord;
    const banner = { firstShownAt: 0, lastShownAt: 30_000, shownMs: 30_000, visibleSince: null, errorCode: "controller_lease_lost" };
    const result = summarizeStagingMix([
      { taskId: "t1", issueId: "i1", record: record(), pass: true, finalStatus: "done" },
      { taskId: "t2", issueId: "i2", record: record({ stagingMix: { retryBanner: banner } }), pass: true, finalStatus: "done" },
      { taskId: "t3", issueId: "i3", record: record({ retry: { at: 1, accepted: true } as TaskRecord["retry"], stagingMix: { retryBanner: banner } }), pass: false, finalStatus: "done" },
      { taskId: "t4", issueId: "i4", record: record({ stagingMix: { retryBanner: banner } }), pass: false, finalStatus: "blocked" },
      { taskId: "t5", issueId: "i5", record: record(), pass: false, finalStatus: "in_progress" },
    ], new Map([["i4", true]]), { violationCount: 2, violations: { nothing_pending: 2 }, agentsWithStalledSlots: 1, openTasks: 3 }, 60_000);
    expect(stagingMixHeadline(result)).toEqual([
      "completed hands-off / started: 2 / 5",
      "Retry banner shown: 3 tasks",
      "Retry worked / Retry clicked: 1 / 2",
    ]);
    expect(result.bannerShown.find(entry => entry.taskId === "t2")).toMatchObject({ completedAnyway: true, errorCode: "controller_lease_lost", shownMs: 30_000 });
    expect(result.invariant.violationCount).toBe(2);
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
    stagingMix: { followUp: null, followUpErrors: [], retries: [], comments } });
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
