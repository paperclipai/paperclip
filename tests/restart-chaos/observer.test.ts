import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChaosApi } from "./api.js";
import { CHILD_WAKE_GRACE_MS, REST_CONFIRM_MS, STALL_GIVE_UP_MS, STOP_CONTINUE_AFTER_MS, TaskObserver, childSpeedTasksInTurn, childrenPending, listWorkspaceFiles, noteLivenessEvent, stopArmed, toRunSample } from "./observer.js";
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

  it("does not finish a staging-mix task on the poll that posts its last after-end follow-up", async () => {
    const previous = { ...process.env };
    const delay = REST_CONFIRM_MS + 50;
    Object.assign(process.env, { RESTART_CHAOS_MIX_FOLLOW_UP_AFTER_END_MS: `${delay}-${delay}`, RESTART_CHAOS_MIX_FOLLOW_UP_COUNT: "1" });
    try {
      let endedAt = 0;
      const { api, posted } = fakeApi({ "/runs": () => [{ runId: "r1", status: "succeeded", createdAt: new Date(endedAt - 1_000).toISOString(),
        finishedAt: new Date(endedAt).toISOString() }] });
      const mixPlan: TaskPlan = { ...plan, workload: "SM", fault: "K0", followUpAfterMs: null,
        stagingMix: { turnMinutes: 2, rounds: 2, subtasks: 0, followUpAfterMs: 1_000, arriveAtMs: 0, holdMs: 0 } };
      const observer = new TaskObserver(mixPlan, api, lab, new Timeline(null), ready);
      await observer.launch();
      const start = observer.record.createdAt!;
      endedAt = start;
      const comments = () => posted.filter(route => route.endsWith("/comments")).length;
      await observer.poll(start + 100);
      expect(comments()).toBe(0);
      await observer.poll(start + 100 + REST_CONFIRM_MS + 1);
      expect(comments()).toBe(1);
      expect(observer.done).toBe(false);
      await observer.poll(start + 200 + REST_CONFIRM_MS + 2);
      expect(observer.done).toBe(false);
      await observer.poll(start + 300 + 2 * REST_CONFIRM_MS + 3);
      expect(observer.done).toBe(true);
    } finally {
      for (const key of ["RESTART_CHAOS_MIX_FOLLOW_UP_AFTER_END_MS", "RESTART_CHAOS_MIX_FOLLOW_UP_COUNT"]) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
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
      "/documents/": () => null, "/recovery-actions": () => ({ active: { id: "a1", status: "active", ownerType: "board" }, actions: [] }), "/api/issues/c2": () => ({ id: "c2", status: childStatus,
        interruption: { canRetry: childStatus === "blocked", observedRunId: "child-run" } }) }, "blocked");
    const childRetries: string[] = [];
    const api = { ...base.api, async get(route: string) {
        if (route === "/api/issues/i1") return { id: "i1", status: "blocked", stalledDependencies: childStatus === "blocked"
          ? [{ stalledIssueId: "c2", relation: "child", recoveryAction: { id: "a1", status: "active", ownerType: "board" } }] : [] };
        return base.api.get(route);
      },
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

  it("M1: rereads a parent whose read failed on the next poll, and reads each stall wake from the parent's activity", async () => {
    const base = fakeApi({ "parentIds=": () => [{ id: "c2", parentId: "i1", status: "blocked" }], "/documents/": () => null, "/comments": () => [],
      "/workspace-operations": () => [], "/api/issues/c2": () => ({ id: "c2", status: "blocked", interruption: { canRetry: false } }),
      "/activity": () => [{ action: "issue.blocker_stalled_wake", details: { stalledIssueId: "c2", recoveryActionId: "a1" } },
        { action: "issue.updated", details: {} }, { action: "issue.blocker_stalled_wake", details: {} }] }, "blocked");
    let failNextStallRead = false;
    const api = { ...base.api, async get(route: string, timeoutMs?: number) {
        if (route === "/api/issues/i1") {
          if (timeoutMs === undefined && failNextStallRead) { failNextStallRead = false; throw new Error("503"); }
          return { id: "i1", status: "blocked", stalledDependencies: [{ stalledIssueId: "c2", relation: "child", recoveryAction: { id: "a1", ownerType: "board" } }] };
        }
        return base.api.get(route);
      }, post: base.api.post.bind(base.api) } as unknown as ChaosApi;
    const observer = new TaskObserver({ ...plan, workload: "M1", followUpAfterMs: null }, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    failNextStallRead = true;
    await observer.poll(start + 1_000);
    expect(observer.record.childStalls ?? []).toEqual([]);
    await observer.poll(start + 2_000);
    expect(observer.record.childStalls).toEqual([{ childIssueId: "c2", recoveryActionId: "a1" }]);
    const artifacts = await observer.collectArtifacts();
    expect(artifacts.stallWakes).toEqual([{ stalledIssueId: "c2", recoveryActionId: "a1" }, { stalledIssueId: null, recoveryActionId: null }]);
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

  it("S1 with a provider fault: stops on the first live provider turn, not the wall-clock window", async () => {
    // Waves w-20261110T082702-s212 and w-20261110T091057-s213: the agent finished
    // before the seeded window, so the PV2 interrupt_ack fault was never injected.
    let events: unknown[] = [];
    let runStatus = "running";
    const base = fakeApi({
      "/events": () => events,
      "/runs": () => [{ id: "r1", status: runStatus, createdAt: new Date(0).toISOString(), finishedAt: null }],
    }, "in_progress");
    const posted: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string) {
      posted.push(route);
      if (route === "/api/heartbeat-runs/r1/cancel") { runStatus = "cancelled"; return { id: "r1" }; }
      return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "comment-1" };
    } } as unknown as ChaosApi;
    const pvPlan: TaskPlan = { ...plan, workload: "S1", adapter: "claude", followUpAfterMs: 60_000,
      providerFault: { kind: "PV2", message: "interrupt_ack" } };
    const observer = new TaskObserver(pvPlan, api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    // Running, but no provider turn yet: the prompt has not reached the provider.
    await observer.poll(start + 500);
    expect(posted.filter(route => route.endsWith("/cancel"))).toEqual([]);
    events = [{ seq: 1, eventType: "turn.started", createdAt: new Date(start + 600).toISOString(), payload: {} }];
    await observer.poll(start + 1_000);
    expect(posted.filter(route => route.endsWith("/cancel"))).toEqual(["/api/heartbeat-runs/r1/cancel"]);
    expect(observer.record.stop).toMatchObject({ runId: "r1", httpStatus: 200 });
    // The continue comment still waits for the seeded window.
    events = [];
    await observer.poll(start + 1_000 + STOP_CONTINUE_AFTER_MS + 1);
    expect(observer.record.followUp).toBeNull();
    await observer.poll(start + 60_000 + 1);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1" });
  });

  it("S1 with a provider fault: does not stop after a turn terminal, and stops once when the next turn starts", async () => {
    const events = [
      { seq: 1, eventType: "turn.started", createdAt: new Date(1).toISOString(), payload: {} },
      { seq: 2, eventType: "turn.completed", createdAt: new Date(2).toISOString(), payload: {} },
    ];
    let nextTurn: unknown[] = [];
    const base = fakeApi({
      "/events": route => route.includes("afterSeq=0") ? events
        : route.includes("afterSeq=2") ? nextTurn : [],
      "/runs": () => [{ id: "r1", status: "running", createdAt: new Date(0).toISOString(), finishedAt: null }],
    }, "in_progress");
    const pvPlan: TaskPlan = { ...plan, workload: "S1", adapter: "claude", followUpAfterMs: 1_000,
      providerFault: { kind: "PV2", message: "interrupt_ack" } };
    const observer = new TaskObserver(pvPlan, base.api, lab, new Timeline(null), ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 5_000);
    expect(base.posted.filter(route => route.endsWith("/cancel"))).toEqual([]);
    expect(observer.record.stop ?? null).toBeNull();
    // The next turn re-arms the Stop, and it fires once.
    nextTurn = [{ seq: 3, eventType: "turn.started", createdAt: new Date(3).toISOString(), payload: {} }];
    await observer.poll(observer.record.createdAt! + 6_000);
    nextTurn = [];
    await observer.poll(observer.record.createdAt! + 7_000);
    expect(base.posted.filter(route => route.endsWith("/cancel"))).toEqual(["/api/heartbeat-runs/r1/cancel"]);
    expect(observer.record.stop).toMatchObject({ runId: "r1" });
  });

  it("S1 with a provider fault: records a missed Stop when the run ends before any live turn and the task rests after the window", async () => {
    const base = fakeApi({ "/events": () => [],
      "/runs": () => [{ id: "r1", status: "succeeded", createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }],
      "/comments": () => [], "/documents/": () => null, "/workspace-operations": () => [] }, "done");
    const timeline = new Timeline(null);
    const pvPlan: TaskPlan = { ...plan, workload: "S1", adapter: "claude", followUpAfterMs: 1_000,
      providerFault: { kind: "PV2", message: "interrupt_ack" } };
    const observer = new TaskObserver(pvPlan, base.api, lab, timeline, ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 500);
    expect(observer.record.stop ?? null).toBeNull();
    await observer.poll(start + 2_000);
    expect(observer.record.stop).toMatchObject({ runId: null, missed: true });
    expect(timeline.entries.some(entry => entry.kind === "task_stop_missed")).toBe(true);
    expect(base.posted.filter(route => route.endsWith("/cancel"))).toEqual([]);
  });

  it("noteLivenessEvent: a runner replacement or stop clears the live provider turn", () => {
    const replaced = { seq: 0, lastAt: null, openTools: 0, process: null } as Parameters<typeof noteLivenessEvent>[0];
    noteLivenessEvent(replaced, { eventType: "native.process_identity_recorded", payload: { targetKind: "local", processPid: 1, processStartedAt: "a" } });
    noteLivenessEvent(replaced, { eventType: "turn.started", payload: {} });
    expect(replaced.turnActive).toBe(true);
    noteLivenessEvent(replaced, { eventType: "native.process_identity_recorded", payload: { targetKind: "local", processPid: 2, processStartedAt: "b" } });
    expect(replaced.turnActive).toBe(false);
    noteLivenessEvent(replaced, { eventType: "turn.started", payload: {} });
    noteLivenessEvent(replaced, { eventType: "native.local_process_stopped", payload: { processPid: 2 } });
    expect(replaced.turnActive).toBe(false);
  });

  it("stopArmed: a provider-fault Stop needs a live provider turn; others keep the window", () => {
    const live = { id: "r1", status: "running", providerTurnActive: true } as never;
    const idle = { id: "r1", status: "running" } as never;
    expect(stopArmed({ now: 0, windowAt: 1_000, providerFault: true, running: live })).toBe(true);
    expect(stopArmed({ now: 5_000, windowAt: 1_000, providerFault: true, running: idle })).toBe(false);
    expect(stopArmed({ now: 5_000, windowAt: 1_000, providerFault: true, running: undefined })).toBe(false);
    expect(stopArmed({ now: 0, windowAt: 1_000, providerFault: false, running: live })).toBe(false);
    expect(stopArmed({ now: 1_000, windowAt: 1_000, providerFault: false, running: undefined })).toBe(true);
  });

  it("S1: holds the Stop while another task's fault has the server down or recovering", async () => {
    const base = fakeApi({ "/runs": () => [{ id: "r1", status: "running", createdAt: new Date(0).toISOString(), finishedAt: null }] }, "in_progress");
    const posted: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string) {
      posted.push(route);
      return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "r1" };
    } } as unknown as ChaosApi;
    const supervisor = { serverReady: true, faultInProgress: false };
    const observer = new TaskObserver({ ...plan, workload: "S1", followUpAfterMs: 1_000 }, api, lab, new Timeline(null), supervisor);
    await observer.launch();
    supervisor.faultInProgress = true;
    await observer.poll(observer.record.createdAt! + 2_000);
    expect(posted.filter(route => route.endsWith("/cancel"))).toEqual([]);
    supervisor.faultInProgress = false;
    await observer.poll(observer.record.createdAt! + 3_000);
    expect(posted.filter(route => route.endsWith("/cancel"))).toEqual(["/api/heartbeat-runs/r1/cancel"]);
  });

  it("S1: records a missed Stop and still posts the continue comment when the run finished before the stop window", async () => {
    const base = fakeApi({ "/runs": () => [{ id: "r1", status: "succeeded", createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }],
      "/comments": () => [], "/documents/": () => null, "/workspace-operations": () => [] }, "done");
    const posted: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string) {
      posted.push(route);
      return route.endsWith("/issues") ? { id: "i1", identifier: "CHA-1" } : { id: "comment-1" };
    } } as unknown as ChaosApi;
    const timeline = new Timeline(null);
    const observer = new TaskObserver({ ...plan, workload: "S1", followUpAfterMs: 1_000 }, api, lab, timeline, ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 2_000);
    expect(observer.record.stop).toMatchObject({ runId: null, missed: true });
    expect(timeline.entries.some(entry => entry.kind === "task_stop_missed")).toBe(true);
    await observer.poll(start + 2_000 + STOP_CONTINUE_AFTER_MS + 1);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1" });
    expect(posted.filter(route => route.endsWith("/cancel"))).toEqual([]);
    expect((await observer.collectArtifacts()).stop).toMatchObject({ missed: true, continuePosted: true, runsStartedBeforeContinue: [] });
  });

  it("S1: arms a stop-triggered fault at the Stop click plus its delay, and misses it when the Stop was missed", async () => {
    const running = fakeApi({ "/runs": () => [{ id: "r1", status: "running", createdAt: new Date(0).toISOString(), finishedAt: null }] }, "in_progress");
    const stopPlan: TaskPlan = { ...plan, workload: "S1", followUpAfterMs: 1_000, trigger: "stop", triggerDelayMs: 500 };
    const observer = new TaskObserver(stopPlan, running.api, lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 5_000)).toBeNull();
    await observer.poll(start + 2_000);
    const clicked = observer.record.stop!.at;
    expect(observer.faultDue(clicked + 499)).toBeNull();
    expect(observer.faultDue(clicked + 500)).toMatchObject({ trigger: "stop", kind: "K1" });

    const finished = fakeApi({ "/runs": () => [{ id: "r1", status: "succeeded", createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }] }, "done");
    const timeline = new Timeline(null);
    const missed = new TaskObserver(stopPlan, finished.api, lab, timeline, ready);
    await missed.launch();
    await missed.poll(missed.record.createdAt! + 2_000);
    expect(missed.record.stop).toMatchObject({ missed: true });
    expect(missed.faultDue(missed.record.createdAt! + 2_600)).toBeNull();
    expect(missed.record.triggerMissed).toEqual(["stop"]);
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

  it.each([
    ["agent-owned interrupted session", { id: "a-agent", status: "cancelled", ownerType: "agent" }],
    ["system reconciliation resolved as cancelled", { id: "a-system", status: "resolved", ownerType: "system", outcome: "cancelled" }],
  ])("records no stall for a blocked subtask the product does not list as stalled (%s), but still clicks its Retry", async (_name, action) => {
    let childStatus = "blocked";
    const base = fakeApi({ "parentIds=": () => [{ id: "c1", parentId: "i1", status: "done" }, { id: "c2", parentId: "i1", status: childStatus }],
      "/documents/": () => null, "/recovery-actions": () => ({ active: null, actions: [action] }),
      "/api/issues/i1": route => route === "/api/issues/i1" ? { id: "i1", status: "blocked", stalledDependencies: [] } : null,
      "/api/issues/c2": () => ({ id: "c2", status: childStatus, interruption: { canRetry: childStatus === "blocked", observedRunId: "child-run" } }) }, "blocked");
    const childRetries: string[] = [];
    const api = { ...base.api, get: base.api.get.bind(base.api), async post(route: string, body: unknown) {
      if (route === "/api/issues/c2/retry") { childRetries.push(route); childStatus = "in_progress"; return { accepted: true }; }
      return (base.api as unknown as { post(route: string, body: unknown): Promise<unknown> }).post(route, body);
    } } as unknown as ChaosApi;
    const observer = new TaskObserver({ ...plan, workload: "M1", followUpAfterMs: null }, api, lab, new Timeline(null), ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 1_000);
    expect(observer.record.childStalls ?? []).toEqual([]);
    expect(childRetries).toEqual(["/api/issues/c2/retry"]);
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

describe("childSpeedTasksInTurn", () => {
  it("reads each observer's subtasks one at a time so a large wave does not flood the API", async () => {
    let inFlight = 0, peak = 0;
    const observers = [1, 2, 3].map(id => ({ childSpeedTasks: async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return [{ issueId: `c${id}`, adapter: "codex" as const, samples: [] }];
    } }));
    expect((await childSpeedTasksInTurn(observers)).map(task => task.issueId)).toEqual(["c1", "c2", "c3"]);
    expect(peak).toBe(1);
  });
});

describe("run samples", () => {
  it("keeps the board's failure cause for U3 and omits it for older servers", () => {
    const base = { runId: "r1", status: "failed", errorCode: "adapter_failed" };
    expect(toRunSample({ ...base, failureCause: "40001" }).failureCause).toBe("40001");
    expect(toRunSample(base)).not.toHaveProperty("failureCause");
    expect(toRunSample({ ...base, failureCause: null })).not.toHaveProperty("failureCause");
  });
});
