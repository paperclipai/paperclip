import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChaosApi } from "./api.js";
import { CHILD_WAKE_GRACE_MS, REST_CONFIRM_MS, STALL_GIVE_UP_MS, STOP_CONTINUE_AFTER_MS, TaskObserver, childrenPending, listWorkspaceFiles } from "./observer.js";
import { gradeTask } from "./grader.js";
import { createFixtureRepository, type ChaosLab } from "./seed.js";
import { Timeline } from "./timeline.js";
import type { TaskPlan } from "./types.js";
import { BENCH_EXPECTED, parseBenchRecord } from "./workloads.js";

process.env.RESTART_CHAOS_QUIET = "1";
const lab: ChaosLab = { companyId: "c1", environmentId: "e1", environmentKind: "local", projectId: "p1", fixtureRepositoryPath: "/tmp/none",
  agents: { codex: { id: "a1", name: "Chaos codex" }, claude: { id: "a2", name: "Chaos claude" }, opencode: { id: "a3", name: "Chaos opencode" } } };
const plan: TaskPlan = { taskId: "t01", index: 0, workload: "C1", adapter: "codex", fault: "K1", fireAfterMs: 999_999,
  holdMs: 0, followUpAfterMs: 1_000, nonce: "abcd1234" };
const ready = { serverReady: true, faultInProgress: false };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/** Fake board API: a C1 issue whose first run already finished. */
function fakeApi(overrides: Partial<Record<string, (route: string) => unknown>> = {}, status = "done") {
  const posted: string[] = [];
  const api = {
    async get(route: string) {
      for (const [prefix, handler] of Object.entries(overrides)) if (route.includes(prefix)) return handler!(route);
      if (route.endsWith("/runs")) return [{ runId: "r1", status: "succeeded", createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }];
      return { id: "i1", status, interruption: null };
    },
    async post(route: string) { posted.push(route); return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "comment-1" }; },
  };
  return { api: api as unknown as ChaosApi, posted };
}

describe("TaskObserver", () => {
  it("does not finish a C1 task on the poll that posts the follow-up", async () => {
    const { api, posted } = fakeApi();
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    // The task rests before the follow-up is due, for longer than the rest window.
    await observer.poll(start + 100);
    await observer.poll(start + 100 + REST_CONFIRM_MS + 1);
    expect(observer.done).toBe(false);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1" });
    expect(posted.some(route => route.endsWith("/comments"))).toBe(true);
    // A fresh rest window must elapse after the comment before the task counts as resting.
    await observer.poll(start + 200 + REST_CONFIRM_MS + 2);
    expect(observer.done).toBe(false);
    await observer.poll(start + 300 + 2 * REST_CONFIRM_MS + 3);
    expect(observer.done).toBe(true);
  });

  it("keeps watching unexplained idle work until the stall limit, then records the stall", async () => {
    const { api } = fakeApi({}, "in_progress");
    const observer = new TaskObserver({ ...plan, workload: "A1", followUpAfterMs: null }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    await observer.poll(start + 1_000 + REST_CONFIRM_MS + 1);
    expect(observer.done).toBe(false);
    await observer.poll(start + 1_000 + STALL_GIVE_UP_MS + 1);
    expect(observer.done).toBe(true);
    expect(observer.record.finalStatus).toBe("in_progress");
    expect(observer.record.restAt).toBe(start + 1_000);
  });

  it("reports a failed workspace-operation read as a sweep error, not a clean rest", async () => {
    const { api } = fakeApi({ "/workspace-operations": () => { throw new Error("timeout"); } });
    const observer = new TaskObserver(plan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const sweep = await observer.sweep();
    expect(sweep.error).toMatch(/timeout/);
  });

  it("leaves R2 unchecked instead of failing the wave when the pre-fault snapshot cannot read the workspace", async () => {
    const { api } = fakeApi({ "/api/issues/i1": route => route.endsWith("/runs") ? []
      : { id: "i1", status: "in_progress", currentExecutionWorkspace: { cwd: "/nonexistent/restart-chaos-workspace" } } });
    const observer = new TaskObserver({ ...plan, workload: "B1", followUpAfterMs: null }, api, lab, new Timeline(null), ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 1_000);
    await expect(observer.snapshotBeforeFault()).resolves.toBeUndefined();
    expect(observer.record.preFaultFiles).toBeNull();
    expect(observer.record.preFaultSnapshotError).toMatch(/ENOENT/);
  });

  it("keeps an M1 parent watched while a subtask runs, then rests it once a subtask is blocked", async () => {
    let childStatus = "in_progress";
    const { api } = fakeApi({ "parentIds=": () => [{ id: "c1", parentId: "i1", status: "done" }, { id: "c2", parentId: "i1", status: childStatus }],
      "/documents/": () => null }, "blocked");
    const timeline = new Timeline(null);
    const observer = new TaskObserver({ ...plan, workload: "M1", followUpAfterMs: null }, api, lab, timeline, ready);
    await observer.launch();
    let now = observer.record.createdAt! + 1_000;
    const restWindow = async () => { await observer.poll(now); now += REST_CONFIRM_MS + 1; await observer.poll(now); now += 1_000; };
    await restWindow();
    await restWindow();
    expect(observer.done).toBe(false);
    childStatus = "blocked";
    await restWindow();
    expect(observer.done).toBe(false);
    expect(timeline.entries.filter(entry => entry.kind === "task_child_blocked")).toHaveLength(1);
    now += CHILD_WAKE_GRACE_MS;
    await restWindow();
    expect(observer.done).toBe(true);
    expect(observer.record.finalStatus).toBe("blocked");
  });

  it("clicks the board Retry on a blocked subtask, as a user would, and keeps watching the parent", async () => {
    let childStatus = "blocked";
    const base = fakeApi({ "parentIds=": () => [{ id: "c1", parentId: "i1", status: "done" }, { id: "c2", parentId: "i1", status: childStatus }],
      "/documents/": () => null, "/recovery-actions": () => ({ active: { id: "a1" }, actions: [] }), "/api/issues/c2": () => ({ id: "c2", status: childStatus,
        interruption: { canRetry: childStatus === "blocked", observedRunId: "child-run" } }) }, "blocked");
    const childRetries: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api),
      async post(route: string, body: unknown) {
        if (route === "/api/issues/c2/retry") { childRetries.push(route); childStatus = "in_progress"; return { accepted: true }; }
        return (base.api as unknown as { post(route: string, body: unknown): Promise<unknown> }).post(route, body);
      } } as unknown as ChaosApi;
    const timeline = new Timeline(null);
    const observer = new TaskObserver({ ...plan, workload: "M1", followUpAfterMs: null }, api, lab, timeline, ready);
    await observer.launch();
    let now = observer.record.createdAt! + 1_000;
    const restWindow = async () => { await observer.poll(now); now += REST_CONFIRM_MS + 1; await observer.poll(now); now += 1_000; };
    await restWindow();
    expect(childRetries).toEqual(["/api/issues/c2/retry"]);
    expect(observer.record.childRetries).toMatchObject([{ childIssueId: "c2", accepted: true, observedRunId: "child-run" }]);
    expect(observer.record.childStalls).toEqual([{ childIssueId: "c2", recoveryActionId: "a1" }]);
    now += CHILD_WAKE_GRACE_MS;
    await restWindow();
    expect(observer.done).toBe(false);
    childStatus = "done";
    await restWindow();
    now += CHILD_WAKE_GRACE_MS;
    await restWindow();
    expect(childRetries).toHaveLength(1);
  });

  it("S1: stops the running run as the board would, then posts the continue comment only after it settles", async () => {
    let runStatus = "running";
    const base = fakeApi({ "/runs": () => [{ id: "r1", status: runStatus, createdAt: new Date(0).toISOString(), finishedAt: null }] }, "in_progress");
    const posted: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string) {
      posted.push(route);
      if (route === "/api/heartbeat-runs/r1/cancel") { runStatus = "cancelled"; return { id: "r1", status: "cancelled" }; }
      return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "comment-1" };
    } } as unknown as ChaosApi;
    const observer = new TaskObserver({ ...plan, workload: "S1", followUpAfterMs: 1_000 }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 2_000);
    expect(posted).toContain("/api/heartbeat-runs/r1/cancel");
    expect(observer.record.stop).toMatchObject({ runId: "r1", httpStatus: 200, error: null });
    await observer.poll(start + 2_000 + STOP_CONTINUE_AFTER_MS - 1);
    expect(observer.record.followUp).toBeNull();
    await observer.poll(start + 2_000 + STOP_CONTINUE_AFTER_MS + 1);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1", duringRun: false });
    expect(posted.filter(route => route.endsWith("/cancel"))).toHaveLength(1);
  });

  it("S1: does not count the continue comment's own run as a run after the stop, even when it starts before the comment returns", async () => {
    let runs: Array<Record<string, unknown>> = [{ id: "r1", status: "running", createdAt: new Date(0).toISOString(), finishedAt: null }];
    const base = fakeApi({ "/runs": () => runs, "/comments": () => [], "/documents/": () => null, "/workspace-operations": () => [] }, "in_progress");
    let clock = 0;
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string) {
      if (route === "/api/heartbeat-runs/r1/cancel") { runs = [{ ...runs[0]!, status: "cancelled" }]; return { id: "r1" }; }
      if (route.endsWith("/comments")) {
        runs = [...runs, { id: "r2", status: "running", createdAt: new Date(clock - 10).toISOString(), finishedAt: null, wakeCommentIds: ["continue-1"] }];
        return { id: "continue-1" };
      }
      return { id: "i1", identifier: "CHA-1" };
    } } as unknown as ChaosApi;
    const observer = new TaskObserver({ ...plan, workload: "S1", followUpAfterMs: 1_000 }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 2_000);
    clock = start + 2_000 + STOP_CONTINUE_AFTER_MS + 1;
    await observer.poll(clock);
    await observer.poll(clock + 3_000);
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.stop).toMatchObject({ runId: "r1", runStatus: "cancelled", runsStartedBeforeContinue: [], continuePosted: true });
  });

  it("S1: counts a run recovery started between the poll's reads and the continue request", async () => {
    let runs: Array<Record<string, unknown>> = [{ id: "r1", status: "running", createdAt: new Date(0).toISOString(), finishedAt: null }];
    let stopped = false;
    const base = fakeApi({ "/runs": () => runs, "/comments": () => [], "/documents/": () => null, "/workspace-operations": () => [] }, "in_progress");
    let sentAt = 0;
    const api = { ...base.api, async get(route: string) {
      const value = await base.api.get(route);
      if (stopped && route.endsWith("/runs") && runs.length === 1) {
        runs = [...runs, { id: "r2", status: "queued", createdAt: new Date(sentAt - 5).toISOString(), finishedAt: null }];
      }
      return value;
    }, async post(route: string) {
      if (route === "/api/heartbeat-runs/r1/cancel") { stopped = true; runs = [{ ...runs[0]!, status: "cancelled" }]; return { id: "r1" }; }
      if (route.endsWith("/comments")) return { id: "continue-1" };
      return { id: "i1", identifier: "CHA-1" };
    } } as unknown as ChaosApi;
    const observer = new TaskObserver({ ...plan, workload: "S1", followUpAfterMs: 1_000 }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 2_000);
    const at = start + 2_000 + STOP_CONTINUE_AFTER_MS + 1;
    sentAt = at + 100;
    runs = [runs[0]!];
    observer.record.followUp = { at, sentAt, postedAt: sentAt + 50, commentId: "continue-1", error: null, duringRun: false };
    observer.record.samples.push({ at: sentAt + 200, reachable: true, serverReady: true, issueStatus: "in_progress", interruption: null,
      activeRecoveryAction: false, recoveryOwner: null, executionBlocker: false, scheduledRetry: false,
      runs: [runs[0], { id: "r2", status: "queued", createdAt: new Date(sentAt - 5).toISOString(), finishedAt: null }] } as never);
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.stop?.runsStartedBeforeContinue).toEqual(["r2"]);
  });

  it("closes an open task as unfinished at interrupt, so the wave grades it as a failure", async () => {
    const { api } = fakeApi({}, "in_progress");
    const timeline = new Timeline(null);
    const observer = new TaskObserver({ ...plan, workload: "A1", followUpAfterMs: null }, api, lab, timeline, ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 1_000);
    observer.markUnfinished();
    expect(observer.done).toBe(true);
    expect(observer.record).toMatchObject({ timedOut: true, finalStatus: "in_progress" });
    expect(timeline.entries.some(entry => entry.kind === "task_unfinished_at_interrupt")).toBe(true);
    const grade = gradeTask(observer.record, [], observer.definition.budgetMs, { verdict: "pass", checks: [] });
    expect(grade.pass).toBe(false);
    expect(grade.rules.R1.detail).toMatch(/no_rest_within_budget/);
  });

  it("fires the planned fault once, after its offset", async () => {
    const { api } = fakeApi();
    const observer = new TaskObserver({ ...plan, fireAfterMs: 5_000 }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 4_999)).toBeNull();
    expect(observer.faultDue(start + 5_000)).toEqual({ kind: "K1", holdMs: 0, atMs: 5_000 });
    expect(observer.faultDue(start + 6_000)).toBeNull();
  });
});

describe("fixture repository", () => {
  it("lists workspace files without VCS or cache directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-fixture-"));
    directories.push(root);
    await createFixtureRepository(root);
    const files = await listWorkspaceFiles(root);
    expect(files).toContain("chaoscli/cli.py");
    expect(files.some(file => file.startsWith(".git/"))).toBe(false);
  });

  it("bench.sh writes a tagged completion record with the deterministic result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-bench-"));
    directories.push(root);
    await createFixtureRepository(root, 1);
    const output = execFileSync("./bench.sh", ["abcd1234"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    expect(output.trim().split("\n").at(-1)).toBe(BENCH_EXPECTED);
    const record = parseBenchRecord(await readFile(path.join(root, ".bench", "run-abcd1234.txt"), "utf8"));
    expect(record?.result).toBe(BENCH_EXPECTED);
  }, 60_000);
});

describe("childrenPending", () => {
  it("waits on running subtasks and stops waiting once each is done, cancelled or blocked", () => {
    expect(childrenPending(null)).toBe(true);
    expect(childrenPending([{ status: "done" }, { status: "in_progress" }])).toBe(true);
    expect(childrenPending([{ status: "done" }, { status: "cancelled" }])).toBe(false);
    expect(childrenPending([{ status: "done" }, { status: "blocked" }])).toBe(false);
  });
});
