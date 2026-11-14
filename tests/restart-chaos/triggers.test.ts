import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isSocketTypeOfServiceRace, type ChaosApi } from "./api.js";
import { parseCommand } from "./config.js";
import { gradeR5 } from "./grader.js";
import { latestIso, localProcessAlive, noteLivenessEvent, QUEUED_TRIGGER_MAX_EMPTY_SAMPLES, TaskObserver, TRIGGER_LATE_MS } from "./observer.js";
import { observedFaultSchedule, planTasks, taskFaultSchedule, TRIGGER_DELAY_RANGE_MS } from "./scheduler.js";
import type { ChaosLab } from "./seed.js";
import { crashLoopShouldFire } from "./supervisor.js";
import { Timeline } from "./timeline.js";
import { ledgerLine } from "./ledger.js";
import type { TaskGrade, TaskPlan, TaskRecord, TaskSample, WaveOptions, WavePlan } from "./types.js";

process.env.RESTART_CHAOS_QUIET = "1";
const lab: ChaosLab = { companyId: "c1", environmentId: "e1", environmentKind: "local", projectId: "p1", fixtureRepositoryPath: "/tmp/none",
  agents: { codex: { id: "a1", name: "Chaos codex" }, claude: { id: "a2", name: "Chaos claude" }, opencode: { id: "a3", name: "Chaos opencode" } } };
const ready = { serverReady: true, faultInProgress: false };
const base: TaskPlan = { taskId: "t01", index: 0, workload: "A1", adapter: "codex", fault: "K1", fireAfterMs: 999_999,
  holdMs: 0, followUpAfterMs: null, nonce: "abcd1234" };
const options: WaveOptions = { env: "local", adapters: ["codex", "claude", "opencode"], workloads: ["A1", "B1", "B5", "C1"],
  faults: ["K1", "K2", "K4", "K6"], concurrency: 3, tasks: 60, seed: 9, budgetCents: 3_000, pollMs: 3_000,
  triggers: ["time", "comment", "retry", "queued", "tool"] };

type Json = Record<string, unknown>;
function scriptedApi(state: { runs: Json[]; issue: Json; retry?: Json; events?: Json[] }) {
  const api = {
    async get(route: string) {
      if (route.includes("/events")) {
        const after = Number(new URL(route, "http://x").searchParams.get("afterSeq") ?? 0);
        return (state.events ?? []).filter(event => Number(event.seq) > after);
      }
      return route.endsWith("/runs") ? state.runs : route.endsWith("/comments") ? [] : state.issue;
    },
    async post(route: string) {
      if (route.endsWith("/issues")) return { id: "i1", identifier: "CHA-1" };
      if (route.endsWith("/retry")) return state.retry ?? { accepted: true };
      return { id: "comment-1" };
    },
  };
  return api as unknown as ChaosApi;
}

describe("trigger planning", () => {
  it("pairs comment only with C1 and tool only with B5, with delays inside each range", () => {
    const tasks = planTasks(options);
    for (const task of tasks) {
      if (task.trigger === "comment") expect(task.workload).toBe("C1");
      if (task.trigger === "tool") expect(task.workload).toBe("B5");
      if (task.trigger && task.trigger !== "time") {
        const [min, max] = TRIGGER_DELAY_RANGE_MS[task.trigger];
        expect(task.triggerDelayMs).toBeGreaterThanOrEqual(min);
        expect(task.triggerDelayMs).toBeLessThanOrEqual(max);
      } else expect(task.triggerDelayMs).toBeUndefined();
    }
    expect(new Set(tasks.map(task => task.trigger ?? "time")).size).toBe(5);
    expect(planTasks(options)).toEqual(tasks);
  });

  it("keeps time-only plans free of trigger fields and rejects a trigger with no fitting workload", () => {
    expect(planTasks({ ...options, triggers: undefined }).every(task => task.trigger === undefined)).toBe(true);
    expect(() => planTasks({ ...options, workloads: ["A1"], triggers: ["tool"] })).toThrow(/needs workload B5/);
  });

  it("schedules the K8 retry fault as an extra K1 after the planned fault", () => {
    expect(taskFaultSchedule({ ...base, fireAfterMs: 30_000, trigger: "retry", triggerDelayMs: 500 })).toEqual([
      { kind: "K1", holdMs: 0, atMs: 30_000 }, { kind: "K1", holdMs: 0, atMs: 0, trigger: "retry", delayMs: 500 }]);
    expect(taskFaultSchedule({ ...base, fault: "K6", trigger: "queued", triggerDelayMs: 0 }))
      .toEqual([{ kind: "K6", holdMs: 0, atMs: 999_999, trigger: "queued", delayMs: 0 }]);
  });

  it("re-arms only the replayed task's own triggered faults", () => {
    const faults = [
      { faultId: "f01", kind: "K1" as const, holdMs: 0, startedAt: 2_000, requestedBy: "t01", trigger: "queued" as const, triggerDelayMs: 0 },
      { faultId: "f02", kind: "K1" as const, holdMs: 0, startedAt: 9_000, requestedBy: "t02", trigger: "comment" as const, triggerDelayMs: 3_000 },
    ];
    expect(observedFaultSchedule(1_000, ["f01", "f02"], faults, "t01")).toEqual([
      { kind: "K1", holdMs: 0, atMs: 1_000, trigger: "queued", delayMs: 0 }, { kind: "K1", holdMs: 0, atMs: 8_000 }]);
  });

  it("parses --triggers and refuses it with --replay", () => {
    expect(parseCommand(["--triggers", "comment,queued"])).toMatchObject({ options: { triggers: ["comment", "queued"] } });
    expect(parseCommand([])).toMatchObject({ options: { triggers: ["time"] } });
    expect(() => parseCommand(["--triggers", "later"])).toThrow(/Unknown triggers/);
    expect(() => parseCommand(["--replay", "w-20261106T101112-s42/t03", "--triggers", "comment"])).toThrow(/reproduces the saved plan/);
  });
});

describe("trigger firing", () => {
  it("queued: fires on the first run that is still queued, and misses once a run has started", async () => {
    const state = { runs: [{ runId: "r1", status: "queued", createdAt: new Date().toISOString() }] as Json[], issue: { id: "i1", status: "todo" } };
    const observer = new TaskObserver({ ...base, trigger: "queued", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start)).toBeNull();
    await observer.poll(start + 10);
    expect(observer.faultDue(start + 10)).toMatchObject({ trigger: "queued", kind: "K1" });

    const late = { runs: [{ runId: "r1", status: "running", startedAt: new Date().toISOString() }] as Json[], issue: { id: "i1", status: "in_progress" } };
    const missed = new TaskObserver({ ...base, trigger: "queued", triggerDelayMs: 0 }, scriptedApi(late), lab, new Timeline(null), ready);
    await missed.launch();
    await missed.poll(missed.record.createdAt! + 10);
    expect(missed.faultDue(missed.record.createdAt! + 10)).toBeNull();
    expect(missed.record.triggerMissed).toEqual(["queued"]);
  });

  it("queued: gives up after several polls with no run at all", async () => {
    const state = { runs: [] as Json[], issue: { id: "i1", status: "todo" } };
    const observer = new TaskObserver({ ...base, trigger: "queued", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    for (let index = 1; index < QUEUED_TRIGGER_MAX_EMPTY_SAMPLES; index += 1) {
      await observer.poll(start + index);
      expect(observer.faultDue(start + index)).toBeNull();
    }
    expect(observer.record.triggerMissed).toBeUndefined();
    await observer.poll(start + 100);
    observer.faultDue(start + 100);
    expect(observer.record.triggerMissed).toEqual(["queued"]);
  });

  it("comment: fires its delay after the follow-up reaches a live run", async () => {
    const state = { runs: [{ runId: "r1", status: "running", startedAt: new Date().toISOString() }] as Json[], issue: { id: "i1", status: "in_progress" } };
    const observer = new TaskObserver({ ...base, workload: "C1", followUpAfterMs: 1_000, trigger: "comment", triggerDelayMs: 2_000 },
      scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 500);
    expect(observer.faultDue(start + 500)).toBeNull();
    await observer.poll(start + 1_500);
    expect(observer.record.followUp).toMatchObject({ commentId: "comment-1", duringRun: true });
    expect(observer.faultDue(start + 3_499)).toBeNull();
    expect(observer.faultDue(start + 3_500)).toMatchObject({ trigger: "comment" });
  });

  it("comment: a follow-up posted to a resting task does not fire", async () => {
    const state = { runs: [{ runId: "r1", status: "succeeded", finishedAt: new Date().toISOString() }] as Json[], issue: { id: "i1", status: "done" } };
    const observer = new TaskObserver({ ...base, workload: "C1", followUpAfterMs: 0, trigger: "comment", triggerDelayMs: 0 },
      scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 10);
    expect(observer.faultDue(observer.record.createdAt! + 10)).toBeNull();
    expect(observer.record.triggerMissed).toEqual(["comment"]);
  });

  it("clicks Retry through the board UI when the wave drives a browser, and records what the user saw", async () => {
    const state = { runs: [{ runId: "r1", status: "failed", finishedAt: new Date().toISOString() }] as Json[],
      issue: { id: "i1", status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r1" } } };
    const clicks: string[] = [];
    const board = { clickRetry: async (issue: string) => { clicks.push(issue);
      return { clicked: true, httpStatus: 202, accepted: true, error: null, bannerText: "Couldn’t finish this attempt." }; } };
    const observer = new TaskObserver(base, scriptedApi(state), lab, new Timeline(null), ready, undefined, board);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    await observer.poll(start + 1_000 + 12_001);
    expect(clicks).toEqual(["CHA-1"]);
    expect(observer.record.retry).toMatchObject({ via: "ui", accepted: true, httpStatus: 202, bannerText: "Couldn’t finish this attempt." });

    const missing = { clickRetry: async () => ({ clicked: false, httpStatus: null, accepted: null, error: "ui_retry_button_missing", bannerText: "Saving files from the previous attempt" }) };
    const blind = new TaskObserver(base, scriptedApi(state), lab, new Timeline(null), ready, undefined, missing);
    await blind.launch();
    await blind.poll(blind.record.createdAt! + 1_000);
    await blind.poll(blind.record.createdAt! + 1_000 + 12_001);
    expect(blind.record.retry).toMatchObject({ via: "ui", accepted: null, error: "ui_retry_button_missing" });
  });

  it("retry: fires the extra K1 right after an accepted Retry click, and closes unfired triggers at sweep", async () => {
    const state = { runs: [{ runId: "r1", status: "failed", finishedAt: new Date().toISOString() }] as Json[],
      issue: { id: "i1", status: "blocked", interruption: { state: "needs_retry", canRetry: true, observedRunId: "r1" } } };
    const observer = new TaskObserver({ ...base, fireAfterMs: 1_000, trigger: "retry", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 1_000)).toEqual({ kind: "K1", holdMs: 0, atMs: 1_000 });
    await observer.poll(start + 2_000);
    expect(observer.faultDue(start + 2_000)).toBeNull();
    await observer.poll(start + 2_000 + 12_001);
    expect(observer.record.retry).toMatchObject({ accepted: true });
    expect(observer.faultDue(start + 14_002)).toMatchObject({ kind: "K1", trigger: "retry" });

    const unclicked = new TaskObserver({ ...base, trigger: "retry", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await unclicked.launch();
    await unclicked.sweep();
    expect(unclicked.record.triggerMissed).toEqual(["retry"]);
  });

  it("clicks Retry once per fault: again only after a fault that started after the last click", async () => {
    const state = { runs: [{ runId: "r1", status: "failed", finishedAt: new Date().toISOString() }] as Json[],
      issue: { id: "i1", status: "blocked", interruption: { state: "failed", canRetry: true, observedRunId: "r1" } } };
    const observer = new TaskObserver({ ...base }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 1_000);
    await observer.poll(start + 1_000 + 12_001);
    const first = observer.record.retry!;
    expect(first.accepted).toBe(true);
    await observer.poll(start + 20_000);
    await observer.poll(start + 20_000 + 12_001);
    expect(observer.done).toBe(true);
    expect(observer.record.retry).toBe(first);

    const again = new TaskObserver({ ...base }, scriptedApi(state), lab, new Timeline(null), ready);
    await again.launch();
    const begin = again.record.createdAt!;
    await again.poll(begin + 1_000);
    await again.poll(begin + 1_000 + 12_001);
    const clicked = again.record.retry!;
    again.noteFault("f01", clicked.at + 1);
    await again.poll(begin + 20_000);
    await again.poll(begin + 20_000 + 12_001);
    expect(again.done).toBe(false);
    expect(again.record.priorRetries).toEqual([clicked]);
    expect(again.record.retry).not.toBe(clicked);
  });

  it("tool: fires its delay after bench.sh progress is first seen", async () => {
    const observer = new TaskObserver({ ...base, workload: "B5", trigger: "tool", triggerDelayMs: 20_000 },
      scriptedApi({ runs: [], issue: { id: "i1", status: "in_progress" } }), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 60_000)).toBeNull();
    observer.record.benchFirstSeenAt = start + 30_000;
    expect(observer.faultDue(start + 49_999)).toBeNull();
    expect(observer.faultDue(start + 50_000)).toMatchObject({ trigger: "tool" });
  });

  it("result: arms from the target run's result event and fires only while that run is running", async () => {
    const running = { runId: "r1", status: "running", startedAt: new Date().toISOString() };
    const state = { runs: [running] as Json[], issue: { id: "i1", status: "in_progress" },
      events: [{ seq: 1, eventType: "turn.started", createdAt: new Date().toISOString() }] as Json[] };
    const observer = new TaskObserver({ ...base, trigger: "result", triggerDelayMs: 2_000 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    observer.record.followUp = { at: start, postedAt: start, commentId: "c1", error: null, duringRun: true };
    await observer.poll(start + 1_000);
    // An unrelated event does not arm the trigger.
    expect(observer.record.resultAcceptedAt).toBeUndefined();
    state.events.push({ seq: 2, eventType: "run.result.accepted", createdAt: new Date().toISOString() });
    await observer.poll(start + 2_000);
    const armedAt = observer.record.resultAcceptedAt!;
    expect(observer.record.resultRunId).toBe("r1");
    expect(observer.faultDue(armedAt + 1_999)).toBeNull();
    const fault = observer.faultDue(armedAt + 2_000);
    expect(fault).toMatchObject({ trigger: "result" });
    expect(await observer.confirmTrigger(fault!, armedAt + 2_000)).toBe(true);
    // The run settled before dispatch: the fault would land outside the window.
    state.runs = [{ ...running, status: "succeeded", finishedAt: new Date().toISOString() }];
    expect(await observer.confirmTrigger(fault!, armedAt + 2_000)).toBe(false);
    expect(observer.record.triggerMissed).toEqual(["result"]);
  });

  it("result: records a miss when the target run settled during the delay", async () => {
    const state = { runs: [{ runId: "r1", status: "running" }] as Json[], issue: { id: "i1", status: "in_progress" },
      events: [{ seq: 1, eventType: "run.result.proposed", createdAt: new Date().toISOString() }] as Json[] };
    const observer = new TaskObserver({ ...base, trigger: "result", triggerDelayMs: 3_000 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    observer.record.followUp = { at: start, postedAt: start, commentId: "c1", error: null, duringRun: true };
    await observer.poll(start + 1_000);
    const armedAt = observer.record.resultAcceptedAt!;
    state.runs = [{ runId: "r1", status: "succeeded" }];
    await observer.poll(armedAt + 1_000);
    expect(observer.faultDue(armedAt + 3_000)).toBeNull();
    expect(observer.record.triggerMissed).toEqual(["result"]);
  });

  it("result: misses when the follow-up was posted at rest", async () => {
    const observer = new TaskObserver({ ...base, trigger: "result", triggerDelayMs: 0 },
      scriptedApi({ runs: [], issue: { id: "i1", status: "done" } }), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    observer.record.followUp = { at: start, postedAt: start, commentId: "c1", error: null, duringRun: false };
    expect(observer.faultDue(start + 1)).toBeNull();
    expect(observer.record.triggerMissed).toEqual(["result"]);
  });

  it("records a miss instead of firing a triggered fault after its window has passed", async () => {
    const observer = new TaskObserver({ ...base, workload: "B5", trigger: "tool", triggerDelayMs: 1_000 },
      scriptedApi({ runs: [], issue: { id: "i1", status: "in_progress" } }), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    observer.record.benchFirstSeenAt = start;
    expect(observer.faultDue(start + 1_000 + TRIGGER_LATE_MS + 1)).toBeNull();
    expect(observer.record.triggerMissed).toEqual(["tool"]);
  });

  it("queued: misses when the run started before the fault could fire", async () => {
    const state = { runs: [{ runId: "r1", status: "queued" }] as Json[], issue: { id: "i1", status: "todo" } };
    const observer = new TaskObserver({ ...base, trigger: "queued", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 10);
    state.runs = [{ runId: "r1", status: "running", startedAt: new Date().toISOString() }];
    await observer.poll(start + 20);
    expect(observer.faultDue(start + 20)).toBeNull();
    expect(observer.record.triggerMissed).toEqual(["queued"]);
  });

  it("keeps replayed fixed-offset faults on time while a re-armed trigger waits", async () => {
    const observer = new TaskObserver({ ...base, workload: "B5", replayFaults: [
      { kind: "K1", holdMs: 0, atMs: 0, trigger: "tool", delayMs: 0 }, { kind: "K2", holdMs: 0, atMs: 5_000 }] },
    scriptedApi({ runs: [], issue: { id: "i1", status: "in_progress" } }), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    expect(observer.faultDue(start + 5_000)).toEqual({ kind: "K2", holdMs: 0, atMs: 5_000 });
    observer.record.benchFirstSeenAt = start + 6_000;
    expect(observer.faultDue(start + 6_000)).toMatchObject({ kind: "K1", trigger: "tool" });
  });
});

describe("ledger load", () => {
  it("records the highest load among the task's crossing faults", () => {
    const plan = { waveId: "w", seed: 1, options: { env: "local" } } as unknown as WavePlan;
    const record = { plan: base, identifier: "CHA-1", issueId: "i1", retry: null } as unknown as TaskRecord;
    const grade = { rules: {}, T: { verdict: "pass" }, crossed: true, crossingFaults: ["f01", "f02"], pass: true, signature: null } as unknown as TaskGrade;
    const line = ledgerLine(plan, record, grade, "sha", null,
      [{ faultId: "f01", loadAvg1m: 12.5 }, { faultId: "f02", loadAvg1m: 21 }, { faultId: "f03", loadAvg1m: 40 }]);
    expect(line.maxLoadAvg1m).toBe(21);
    expect(ledgerLine(plan, record, grade, "sha", null).maxLoadAvg1m).toBeUndefined();
  });
});

describe("pre-fault files", () => {
  it("checks lost files in the workspace the snapshot was taken from, and records a move", async () => {
    const before = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-before-"));
    const after = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-after-"));
    try {
      await writeFile(path.join(before, "kept.txt"), "x");
      await writeFile(path.join(before, "other-task.txt"), "x");
      const state = { runs: [] as Json[], issue: { id: "i1", status: "in_progress", currentExecutionWorkspace: { cwd: before } } as Json };
      const observer = new TaskObserver({ ...base, workload: "B5" }, scriptedApi(state), lab, new Timeline(null), ready);
      await observer.launch();
      await observer.poll(observer.record.createdAt! + 10);
      await observer.snapshotBeforeFault();
      await rm(path.join(before, "other-task.txt"));
      state.issue = { id: "i1", status: "done", currentExecutionWorkspace: { cwd: after } };
      await observer.collectArtifacts();
      expect(observer.record.lostFiles).toEqual(["other-task.txt"]);
      expect(observer.record.workspaceMovedTo).toBe(after);
    } finally {
      await rm(before, { recursive: true, force: true });
      await rm(after, { recursive: true, force: true });
    }
  });
});

describe("dispatch checks", () => {
  it("confirmTrigger rechecks a queued run right before the kill", async () => {
    const state = { runs: [{ runId: "r1", status: "queued" }] as Json[], issue: { id: "i1", status: "todo" } };
    const observer = new TaskObserver({ ...base, trigger: "queued", triggerDelayMs: 0 }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    const start = observer.record.createdAt!;
    await observer.poll(start + 10);
    const due = observer.faultDue(start + 10)!;
    expect(await observer.confirmTrigger(due, start + 20)).toBe(true);
    state.runs = [{ runId: "r1", status: "running", startedAt: new Date().toISOString() }];
    expect(await observer.confirmTrigger(due, start + 30)).toBe(false);
    expect(observer.record.triggerMissed).toEqual(["queued"]);
    expect(await observer.confirmTrigger({ kind: "K1", holdMs: 0, atMs: 0 }, start)).toBe(true);
  });

  it("records an unreadable pre-fault workspace at rest instead of reporting every file lost", async () => {
    const before = await mkdtemp(path.join(os.tmpdir(), "restart-chaos-gone-"));
    await writeFile(path.join(before, "a.txt"), "x");
    const state = { runs: [] as Json[], issue: { id: "i1", status: "in_progress", currentExecutionWorkspace: { cwd: before } } as Json };
    const observer = new TaskObserver({ ...base, workload: "B5" }, scriptedApi(state), lab, new Timeline(null), ready);
    await observer.launch();
    await observer.poll(observer.record.createdAt! + 10);
    await observer.snapshotBeforeFault();
    await rm(before, { recursive: true, force: true });
    state.issue = { id: "i1", status: "done" };
    await observer.collectArtifacts();
    expect(observer.record.lostFiles).toBeNull();
    expect(observer.record.restSnapshotError).toMatch(/ENOENT/);
  });
});

describe("R5 live evidence", () => {
  const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/rc30-terminal-then-k2.json"), "utf8")) as { samples: TaskSample[] };
  const record = (samples: TaskSample[]) => ({ samples } as unknown as TaskRecord);

  it("fails a run that stays running with no event evidence after the server is ready (RC-30, w-20261106T190257-s707/t05)", () => {
    expect(gradeR5(record(fixture.samples))).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/^silent_dead_run b57890ae/) });
  });

  it("passes the same timeline while the run keeps producing events", () => {
    const live = fixture.samples.map(sample => ({ ...sample,
      runs: sample.runs?.map(run => ({ ...run, lastEvidenceAt: new Date(sample.at - 30_000).toISOString() })) }));
    expect(gradeR5(record(live)).verdict).toBe("pass");
  });

  it("counts only time since the server became ready", () => {
    const start = Date.parse("2026-11-06T10:00:00Z");
    const run = { id: "r1", status: "running", createdAt: null, startedAt: new Date(start - 600_000).toISOString(), finishedAt: null,
      errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null, lastEvidenceAt: null };
    const sample = (at: number, ready = true): TaskSample => ({ at, reachable: ready, serverReady: ready, issueStatus: "in_progress", runs: [run] });
    expect(gradeR5(record([sample(start, false), sample(start + 1_000), sample(start + 120_000)])).verdict).toBe("pass");
    expect(gradeR5(record([sample(start, false), sample(start + 1_000), sample(start + 200_000)])).verdict).toBe("fail");
  });

  const quietB5 = (live: { toolInFlight?: boolean; processAlive?: boolean }) => {
    // A B5 run quiet for 4 minutes while bench.sh runs: no event, no activity, started long before.
    const start = Date.parse("2026-11-06T10:00:00Z");
    const run = { id: "r1", status: "running", createdAt: null, startedAt: new Date(start - 600_000).toISOString(), finishedAt: null,
      errorCode: null, retryOfRunId: null, wakeCommentIds: [], livenessState: null, lastEvidenceAt: new Date(start).toISOString(), ...live };
    return record([0, 60_000, 120_000, 180_000, 240_000].map(offset => ({ at: start + offset, reachable: true, serverReady: true,
      issueStatus: "in_progress", runs: [run] })));
  };

  it("does not flag a quiet run whose tool is still in flight or whose process is verifiably alive (B5 quiet 4 min)", () => {
    expect(gradeR5(quietB5({ toolInFlight: true })).verdict).toBe("pass");
    expect(gradeR5(quietB5({ processAlive: true })).verdict).toBe("pass");
    expect(gradeR5(quietB5({}))).toMatchObject({ verdict: "fail", detail: expect.stringMatching(/^silent_dead_run r1/) });
  });

  it("derives tool-in-flight and process liveness from run events", async () => {
    const startedAt = new Date().toISOString();
    const identity = { processPid: 4242, processGroupId: 4242, processStartedAt: "2026-11-06T10:00:00.000Z", targetKind: "local" };
    const state = { runs: [{ runId: "r1", status: "running", startedAt }] as Json[], issue: { id: "i1", status: "in_progress" },
      events: [{ seq: 1, eventType: "native.process_identity_recorded", payload: identity, createdAt: startedAt },
        { seq: 2, eventType: "tool.execution.started", payload: {}, createdAt: startedAt }] as Json[] };
    const observer = new TaskObserver({ ...base, workload: "B5" }, scriptedApi(state), lab, new Timeline(null), ready);
    const checked: Array<[number, string]> = [];
    observer.processAlive = (pid, at) => { checked.push([pid, at]); return true; };
    await observer.launch();
    await observer.poll(Date.now());
    expect(observer.record.samples.at(-1)!.runs![0]).toMatchObject({ toolInFlight: true, processAlive: true });
    expect(checked).toEqual([[4242, "2026-11-06T10:00:00.000Z"]]);
    state.events.push({ seq: 3, eventType: "tool.execution.completed", payload: {}, createdAt: startedAt },
      { seq: 4, eventType: "native.local_process_stopped", payload: { processPid: 4242 }, createdAt: startedAt });
    await observer.poll(Date.now() + 3_000);
    const latest = observer.record.samples.at(-1)!.runs![0]!;
    expect(latest.toolInFlight).toBeUndefined();
    expect(latest.processAlive).toBeUndefined();
  });

  it("drops tool liveness when the runner that owned the tool stops or is replaced", () => {
    const cursor = { seq: 0, lastAt: null, openTools: 0, process: null as { pid: number; startedAt: string } | null };
    const identity = (pid: number) => ({ eventType: "native.process_identity_recorded",
      payload: { processPid: pid, processStartedAt: "2026-11-06T10:00:00.000Z", targetKind: "local" } });
    noteLivenessEvent(cursor, identity(10));
    noteLivenessEvent(cursor, { eventType: "tool.execution.started", payload: {} });
    expect(cursor.openTools).toBe(1);
    // A fault killed the runner mid-tool: the tool can never report its end.
    noteLivenessEvent(cursor, { eventType: "native.local_process_stopped", payload: { processPid: 10 } });
    expect(cursor).toMatchObject({ openTools: 0, process: null });
    noteLivenessEvent(cursor, identity(11));
    noteLivenessEvent(cursor, { eventType: "tool.execution.started", payload: {} });
    // A replacement runner recorded without a stop event still resets the count.
    noteLivenessEvent(cursor, identity(12));
    expect(cursor).toMatchObject({ openTools: 0, process: { pid: 12 } });
  });

  it("records a due trigger the wave skipped as missed", async () => {
    const observer = new TaskObserver({ ...base, workload: "C1", trigger: "result", triggerDelayMs: 0 },
      scriptedApi({ runs: [], issue: { id: "i1", status: "in_progress" } }), lab, new Timeline(null), ready);
    observer.markTriggerMissed({ kind: "K1", holdMs: 0, atMs: 0, trigger: "result", delayMs: 0 });
    observer.markTriggerMissed({ kind: "K2", holdMs: 0, atMs: 0 });
    expect(observer.record.triggerMissed).toEqual(["result"]);
  });

  it.skipIf(process.platform === "win32")("checks a local process by PID and start time, so a recycled PID is not alive", () => {
    const lstart = spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }).stdout.trim();
    const startedAt = new Date(Date.parse(lstart)).toISOString();
    expect(localProcessAlive(process.pid, startedAt)).toBe(true);
    expect(localProcessAlive(process.pid, new Date(Date.parse(lstart) - 60_000).toISOString())).toBe(false);
  });

  it("keeps the latest evidence timestamp", () => {
    expect(latestIso([null, "2026-11-06T10:00:00Z", "2026-11-06T09:00:00Z", "bad"])).toBe("2026-11-06T10:00:00.000Z");
    expect(latestIso([undefined])).toBeNull();
  });
});

describe("socket race", () => {
  it("matches only the undici setTypeOfService EINVAL race", () => {
    expect(isSocketTypeOfServiceRace(Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL", syscall: "setTypeOfService" }))).toBe(true);
    expect(isSocketTypeOfServiceRace(Object.assign(new Error("x"), { code: "EINVAL", syscall: "write" }))).toBe(false);
    expect(isSocketTypeOfServiceRace(null)).toBe(false);
  });
});

describe("timeline", () => {
  it("keeps the event kind when event data has a kind field", () => {
    expect(new Timeline(null).add("fault_started", { kind: "K1" }).kind).toBe("fault_started");
  });
});

describe("K6 crash loop", () => {
  it("kills in recovering (or ready when recovering was skipped), then just after ready", () => {
    expect(crashLoopShouldFire("recovering", "starting")).toBe(false);
    expect(crashLoopShouldFire("recovering", "unreachable")).toBe(false);
    expect(crashLoopShouldFire("recovering", "recovering")).toBe(true);
    expect(crashLoopShouldFire("recovering", "ready")).toBe(true);
    expect(crashLoopShouldFire("ready", "recovering")).toBe(false);
    expect(crashLoopShouldFire("ready", "ready")).toBe(true);
  });
});
