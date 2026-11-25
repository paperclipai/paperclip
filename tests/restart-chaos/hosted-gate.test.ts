import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostedGate, hostedQueueWait, hostedR1, releaseOutages, subtaskRecord } from "./hosted-gate.js";
import { gradeHosted } from "./hosted-grade.js";
import { continuity } from "./hosted-release.js";
import { runRow, type HostedRunRow } from "./hosted-readers.js";
import type { DetectedRelease, HealthSample } from "./hosted-release.js";
import type { HostedTaskRecord } from "./hosted-workload.js";
import type { SwapMetrics } from "./release-swap-grade.js";
import { roundsFor, stagingMixBudgetMs, SUBTASK_ROUNDS } from "./staging-mix.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const task = { turnMinutes: 5, rounds: roundsFor(5), subtasks: 0, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 };
const BUDGET_MIN = stagingMixBudgetMs(task) / MIN;

function record(overrides: Partial<HostedTaskRecord> = {}): HostedTaskRecord {
  return { plan: { index: 0, adapter: "opencode", nonce: "abcd1234", task }, issueId: "i1", identifier: "GIT-1", createdAt: T0, createError: null,
    status: "done", lastLiveAt: null, followUp: null, retryClicks: [], retriedRuns: [], doneAt: null, ...overrides };
}

const run = (id: string, created: number, started: number | null, finished: number | null, extra: Record<string, unknown> = {}): HostedRunRow =>
  runRow({ id, agentId: "a1", issueId: "i1", status: finished === null ? "running" : "succeeded", createdAt: at(created), startedAt: started === null ? null : at(started),
    finishedAt: finished === null ? null : at(finished), invocationSource: "assignment", ...extra });

const agents = [{ id: "a1", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }];
const qw = (companyRuns: HostedRunRow[]) => hostedQueueWait(["a1"], agents, companyRuns).queueWait;

function release(overrides: Partial<DetectedRelease> = {}): DetectedRelease {
  return { index: 1, from: { processStartedAt: "a", commit: "c1" }, to: { processStartedAt: "b", commit: "c2" }, commitChanged: true, lastOldOnlyAt: T0,
    firstNewAt: T0 + MIN, lastOldAt: T0 + 2 * MIN, overlapWindow: { from: T0 + MIN, to: T0 + 2 * MIN }, shape: "overlap", failedRequests: 0, slowRequests: 0,
    firstFailureAt: null, timeToFirstNewMs: MIN, settled: true, ...overrides };
}

describe("hosted R1", () => {
  it("passes a task done inside the staging-mix budget and fails one done after it with no fair queue wait", () => {
    const fast = hostedR1({ record: record(), view: { status: "done", completedAt: at(10) }, runs: [run("r1", 0, 0, 10)], queueWait: qw([run("r1", 0, 0, 10)]), outages: [] });
    expect(fast.verdict).toBe("pass");
    const late = BUDGET_MIN + 5;
    const slow = hostedR1({ record: record(), view: { status: "done", completedAt: at(late) }, runs: [run("r1", 0, 0, late)], queueWait: qw([run("r1", 0, 0, late)]), outages: [] });
    expect(slow).toMatchObject({ verdict: "fail" });
    expect(slow.detail).toMatch(/^done_too_late/);
  });

  it("credits the first run's queue wait when the agent's only slot was busy the whole time", () => {
    const wait = 30;
    const done = wait + BUDGET_MIN - 5;
    const busy = run("other", -1, -1, wait, { issueId: "i0" });
    const mine = run("r1", 0, wait, done);
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [mine], queueWait: qw([busy, mine]), outages: [] });
    expect(graded.verdict).toBe("pass");
    expect(graded.detail).toContain("fair queue wait");
  });

  it("fails an unfair wait: a newer assignment run of the same agent started ahead of the task's run", () => {
    const wait = 30;
    const done = wait + BUDGET_MIN - 5;
    const overtaker = run("newer", 1, 2, wait, { issueId: "i0" });
    const mine = run("r1", 0, wait, done);
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [mine], queueWait: qw([overtaker, mine]), outages: [] });
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toMatch(/^unfair_queue_wait/);
  });

  it("credits outage time only for a release whose health probes failed before the new build answered", () => {
    expect(releaseOutages([release()])).toEqual([]);
    const outage = releaseOutages([release({ shape: "stop_then_start", firstFailureAt: T0 + 10 * MIN, firstNewAt: T0 + 20 * MIN })]);
    expect(outage).toHaveLength(1);
    expect(outage[0]).toMatchObject({ startedAt: T0 + 10 * MIN, readyAt: T0 + 20 * MIN });
    const done = BUDGET_MIN + 5;
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: at(done) }, runs: [run("r1", 0, 0, done)], queueWait: qw([run("r1", 0, 0, done)]), outages: outage });
    expect(graded.verdict).toBe("pass");
  });

  it("never credits a follow-up run's queue wait, because the API has no wake evidence", () => {
    const first = run("r1", 0, 0, 5);
    const busy = run("other", 4, 4, 40, { issueId: "i0" });
    const follow = run("r2", 6, 40, 45, { invocationSource: "automation", contextSnapshot: { wakeCommentIds: ["c1"] } });
    const done = 45;
    expect(done).toBeGreaterThan(BUDGET_MIN);
    const graded = hostedR1({ record: record({ followUp: { at: T0 + 6 * MIN - 1, commentId: "c1", error: null } }), view: { status: "done", completedAt: at(done) },
      runs: [first, follow], queueWait: qw([first, busy, follow]), outages: [] });
    expect(graded.verdict).toBe("fail");
    expect(graded.detail).toContain("no wake evidence for follow-up run r2");
  });

  it("names an agent whose maxConcurrentRuns cannot be read", () => {
    expect(hostedQueueWait(["a1", "a2"], [agents[0]!, { id: "a2", runtimeConfig: null }], []).missing).toEqual(["a2"]);
    expect(hostedQueueWait(["a1"], [], []).missing).toEqual(["a1"]);
  });

  it("marks a task that needed Retry n/a for R1 and fails one that did not rest done", () => {
    const retried = hostedR1({ record: record({ retryClicks: [{ at: T0, accepted: true, via: "grader" }] }), view: { status: "done", completedAt: at(10) },
      runs: [], queueWait: qw([]), outages: [] });
    expect(retried.verdict).toBe("n/a");
    const open = hostedR1({ record: record(), view: { status: "in_progress" }, runs: [run("r1", 0, 0, null)], queueWait: qw([]), outages: [] });
    expect(open.detail).toMatch(/^rested_not_done/);
  });
});

describe("gate D verdict", () => {
  const metric = (index: number, survivors: number): SwapMetrics => ({ index, failedRuns: [], lostWhileOldAlive: [],
    survivors: Array.from({ length: survivors }, (_, n) => ({ runId: `r${n}`, nextEventAfterMs: 1_000 })), nextEventP50Ms: 1_000, nextEventMaxMs: 1_000, survivorsWithoutEvent: 0 });
  const clean = { handsOffPass: true, wantedReleases: 1, createErrors: 0, slotEvidenceMissing: [] as string[], r1: [{ identifier: "GIT-1", result: { verdict: "pass" as const, detail: "done" } }], bannersShown: 0,
    health: { requests: 100, failures: 0, slow: 0, longestGapMs: 2_000, longestGap: null },
    duplicates: { overlappingRuns: [], duplicateComments: [], duplicateChildren: [] }, releases: [release()], metrics: [metric(1, 3)] };

  it("passes only when every criterion holds", () => {
    const gate = hostedGate(clean);
    expect(gate.pass).toBe(true);
    expect(gate.lines[0]).toBe("Gate D: PASS");
  });

  it.each([
    ["a banner", { bannersShown: 1 }, "Retry banners"],
    ["a failed health probe", { health: { ...clean.health, failures: 1 } }, "health probes"],
    ["a duplicated comment", { duplicates: { ...clean.duplicates, duplicateComments: [{ issueId: "i1", count: 2 }] } }, "duplicates"],
    ["a stop-then-start release", { releases: [release({ shape: "stop_then_start" })] }, "swap shape"],
    ["a release with no live run", { metrics: [metric(1, 0)] }, "releases under load"],
    ["no release", { releases: [], metrics: [] }, "releases under load"],
    ["an R1 failure", { r1: [{ identifier: "GIT-2", result: { verdict: "fail" as const, detail: "done_too_late 9s > 1s" } }] }, "R1"],
    ["a task that was not hands-off", { handsOffPass: false }, "hands-off"],
    ["a task that could not be created", { createErrors: 1 }, "tasks created"],
    ["unreadable agent slots", { slotEvidenceMissing: ["a1"] }, "agent slot evidence"],
  ])("fails on %s", (_name, change, check) => {
    const gate = hostedGate({ ...clean, ...change });
    expect(gate.pass).toBe(false);
    expect(gate.lines.find(line => line.includes(`FAIL ${check}`))).toBeDefined();
  });

  it("does not require a release for a fixed batch (--hosted-releases 0)", () => {
    const gate = hostedGate({ ...clean, wantedReleases: 0, releases: [], metrics: [] });
    expect(gate.pass).toBe(true);
    expect(gate.lines.some(line => line.includes("releases under load"))).toBe(false);
  });
});

describe("hosted grade with the run's task records", () => {
  const issue = (id: string, extra: Record<string, unknown> = {}) => ({ id, identifier: id.toUpperCase(), title: id, status: "done", assigneeAgentId: "a1",
    createdAt: at(0), completedAt: at(10), ...extra });
  const apiFor = (issues: Json[], runs: Json[]) => ({
    get: async <T>(route: string) => (route.includes("heartbeat-runs") ? runs : route.includes("/issues?") ? issues
      : route.startsWith("/api/issues/") && !route.slice("/api/issues/".length).includes("/") ? issues.find(entry => route.endsWith(`/${entry.id}`)) ?? { status: "unreadable" }
        : route.endsWith("/agents") ? (agentList ?? (() => { throw new Error("forbidden"); })()) : []) as T,
    post: async <T>() => ({}) as T,
  });
  type Json = Record<string, any>;
  let events: string[] = [];
  let agentList: Json[] | null = agents;
  const grade = async (issues: Json[], runs: Json[], tasks: HostedTaskRecord[], wantedReleases: number) => {
    events = [];
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-gate-"));
    dirs.push(dir);
    return gradeHosted({ api: apiFor(issues, runs), companyId: "c1", agentIds: ["a1"], releases: [], health: () => continuity([]), apiContinuity: () => continuity([]),
      stopObserver: async () => {}, observedClicks: () => new Map(), lastReleaseAt: Date.now() - 1_000, settleMs: 5, drainMs: 5, dir, cancelled: () => false,
      record: event => events.push(event), pollMs: 5, tasks: () => tasks, wantedReleases });
  };
  const runOf = (id: string, issueId: string, created: number, finished: number) => ({ id, agentId: "a1", issueId, status: "succeeded", invocationSource: "assignment",
    createdAt: at(created), startedAt: at(created), finishedAt: at(finished) });

  it("passes a healthy fixed batch with no release", async () => {
    const graded = await grade([issue("i1")], [runOf("r1", "i1", 0, 10)], [record()], 0);
    expect(graded.pass).toBe(true);
    expect(graded.markdown).toContain("Gate D: PASS");
  });

  it("grades an agent-created subtask on its own two-round budget", async () => {
    const budget = stagingMixBudgetMs({ ...task, rounds: SUBTASK_ROUNDS }) / MIN;
    const late = budget + 5;
    const child = issue("c1", { parentId: "i1", createdAt: at(1), completedAt: at(1 + late) });
    const graded = await grade([issue("i1", { completedAt: at(late + 2) }), child], [runOf("r1", "i1", 0, 3), runOf("r2", "c1", 1, 1 + late), runOf("r3", "i1", late + 1, late + 2)],
      [record({ plan: { ...record().plan, task: { ...task, subtasks: 2 } } })], 0);
    expect(graded.pass).toBe(false);
    expect(graded.markdown).toMatch(/FAIL R1: 1 failed \(C1: done_too_late/);
  });

  it("builds a subtask record from its issue view", () => {
    const child = subtaskRecord({ id: "c1", identifier: "GIT-9", status: "done", createdAt: at(3) }, []);
    expect(child).toMatchObject({ issueId: "c1", identifier: "GIT-9", createdAt: T0 + 3 * MIN, createError: null });
    expect(child.plan.task.rounds).toBe(SUBTASK_ROUNDS);
    expect(subtaskRecord({ id: "c2", status: "done" }, []).createError).toBe("subtask has no createdAt");
    expect(subtaskRecord({ id: "c3", status: "done", createdAt: T0 }, []).createdAt).toBe(T0);
  });

  it("reads a numeric completedAt as well as an ISO string", () => {
    const graded = hostedR1({ record: record(), view: { status: "done", completedAt: T0 + 10 * MIN }, runs: [run("r1", 0, 0, 10)], queueWait: qw([run("r1", 0, 0, 10)]), outages: [] });
    expect(graded.verdict).toBe("pass");
  });

  it("grades only subtasks of launched tasks, not another issue the agent created", async () => {
    const budget = stagingMixBudgetMs({ ...task, rounds: SUBTASK_ROUNDS }) / MIN;
    const late = budget + 5;
    const stray = issue("x1", { createdAt: at(1), completedAt: at(1 + late) });
    const graded = await grade([issue("i1"), stray], [runOf("r1", "i1", 0, 10), runOf("r2", "x1", 1, 1 + late)], [record()], 0);
    expect(graded.markdown).not.toContain("FAIL R1");
  });

  it("stops the health probe, settles the frozen samples, and detects releases from them before grading", async () => {
    const order: string[] = [];
    const failure = { url: "/api/health", method: "GET", aborted: false, answer: null, cause: { name: "Error", message: "reset", code: "ECONNRESET" }, connection: null,
      clock: { timeoutMs: 10_000, elapsedMs: 40, monotonicMs: 40, timerLagMs: null, clockJumpMs: 0, loopDelayMaxMs: 20, gapBeforeMs: null, intervalMs: 2_000 },
      control: null, retry: null, controlReachedThisRun: true, class: "unclassified" as const, reason: "diagnosis pending", state: "pending" as const };
    const answer = (at: number, processStartedAt: string) => ({ at, ok: true, status: 200, ms: 40, processStartedAt, commit: "c" });
    const samples = [answer(T0, "old"), answer(T0 + 2_000, "old"), { at: T0 + 4_000, ok: false, status: null, ms: 40, processStartedAt: null, commit: null, failure },
      answer(T0 + 6_000, "new")];
    const stale = await gradeHealth(samples, order, async () => {
      order.push("settle");
      Object.assign(failure, { control: { url: "c", ok: false, status: null, ms: 40, error: { name: "TypeError", message: "fetch failed" }, remoteAddress: null },
        class: "client", reason: "control failed too", state: "settled" });
      return 0;
    });
    expect(order.slice(0, 2)).toEqual(["stop", "settle"]);
    expect(stale.markdown).toContain("- pass health probes: 1 of 4 failed (0 server-side, 0 unclassified, 1 client-side, informational)");
    expect(stale.markdown).toContain("- pass swap shape: no stop-then-start release");
    Object.assign(failure, { class: "unclassified", reason: "diagnosis pending", state: "pending" });
    const pending = await gradeHealth(samples, [], async () => 1);
    expect(pending.pass).toBe(false);
    expect(pending.markdown).toContain("FAIL swap shape: stop-then-start at release 1");
    expect(pending.markdown).toContain("diagnosis did not finish before the grade");
  });

  const gradeHealth = async (samples: HealthSample[], order: string[], settle: () => Promise<number>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-gate-"));
    dirs.push(dir);
    return gradeHosted({ api: apiFor([issue("i1")], [runOf("r1", "i1", 0, 10)]), companyId: "c1", agentIds: ["a1"], releases: [], health: () => continuity([]),
      healthSamples: () => samples, stopHealthProbe: async () => { order.push("stop"); }, settleDiagnostics: settle, apiContinuity: () => continuity([]),
      stopObserver: async () => {}, observedClicks: () => new Map(), lastReleaseAt: Date.now() - 1_000, settleMs: 5, drainMs: 5, dir, cancelled: () => false,
      record: () => {}, pollMs: 5, tasks: () => [record()], wantedReleases: 0 });
  };

  it("fails the gate and records why when the agent list cannot be read", async () => {
    agentList = null;
    try {
      const graded = await grade([issue("i1")], [runOf("r1", "i1", 0, 10)], [record()], 0);
      expect(graded.pass).toBe(false);
      expect(graded.markdown).toContain("FAIL agent slot evidence");
      expect(events).toEqual(expect.arrayContaining(["hosted_agents_unavailable", "hosted_agent_slots_unavailable"]));
    } finally {
      agentList = agents;
    }
  });
});
