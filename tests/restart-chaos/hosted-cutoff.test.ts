import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostedQueueWait, queuedBehindSlotCap, slotQueuedRuns } from "./hosted-gate.js";
import { drainHosted, gradeHosted } from "./hosted-grade.js";
import { duplicateAgentComments, runRow } from "./hosted-readers.js";
import { continuity } from "./hosted-release.js";
import type { HostedTaskRecord } from "./hosted-workload.js";
import { isNoticeRepeat, LOOP_GUARD_NOTICE } from "./release-swap-grade.js";
import { roundsFor } from "./staging-mix.js";

type Json = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const T0 = Date.parse("2026-11-22T05:00:00.000Z");
const MIN = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const task = { turnMinutes: 15, rounds: roundsFor(15), subtasks: 2, followUpAfterMs: null, arriveAtMs: 0, holdMs: 0 };

function planned(issueId: string, identifier: string, createdAt: number): HostedTaskRecord {
  return { plan: { index: 0, adapter: "opencode", nonce: identifier, task }, issueId, identifier, createdAt, createError: null, status: "in_progress",
    lastLiveAt: null, followUp: null, retryClicks: [], retriedRuns: [], doneAt: null };
}

const apiRun = (id: string, issueId: string, createdAt: number, startedAt: number | null, extra: Json = {}): Json => ({ id, agentId: "a1", issueId,
  status: startedAt === null ? "queued" : "running", invocationSource: "assignment", createdAt: iso(createdAt), startedAt: startedAt === null ? null : iso(startedAt),
  finishedAt: null, updatedAt: iso(startedAt ?? createdAt), ...extra });

describe("end-of-wave drain after a run that stopped at the max-hours cap", () => {
  it("drains from the end of arrivals, not from a release fifteen hours earlier", async () => {
    let clock = T0;
    const finishAt = T0 + 20 * MIN;
    const api = { get: async <T>() => {
      clock += MIN;
      const done = clock >= finishAt;
      return [{ id: "r1", agentId: "a1", issueId: "i1", status: done ? "succeeded" : "running", createdAt: iso(T0 - 5 * MIN), startedAt: iso(T0 - 5 * MIN),
        finishedAt: done ? iso(finishAt) : null, updatedAt: iso(Math.min(clock, finishAt)) }] as T;
    }, post: async <T>() => ({}) as T };
    const events: Json[] = [];
    const drained = await drainHosted({ api, companyId: "c1", agentIds: ["a1"], lastReleaseAt: T0 - 15 * 60 * MIN, settleMs: 15 * MIN, drainMs: 57 * MIN,
      cancelled: () => false, record: (kind, data) => events.push({ kind, ...data }), pollMs: 1, now: () => clock, quietMs: 90_000 });
    expect(drained.reason).toBe("quiet");
    expect(clock).toBeGreaterThanOrEqual(finishAt + 90_000);
    expect(events[0]).toMatchObject({ kind: "hosted_settling", drainFrom: iso(T0), capAt: iso(T0 + 57 * MIN) });
  });

  it("still stops at a bounded cap when a run never goes quiet", async () => {
    let clock = T0;
    const api = { get: async <T>() => {
      clock += MIN;
      return [{ id: "r1", agentId: "a1", issueId: "i1", status: "running", createdAt: iso(T0), startedAt: iso(T0), finishedAt: null, updatedAt: iso(clock) }] as T;
    }, post: async <T>() => ({}) as T };
    const drained = await drainHosted({ api, companyId: "c1", agentIds: ["a1"], lastReleaseAt: T0 - 15 * 60 * MIN, settleMs: 15 * MIN, drainMs: 30 * MIN,
      cancelled: () => false, record: () => {}, pollMs: 1, now: () => clock, quietMs: 90_000 });
    expect(drained).toEqual({ reason: "cap", progressing: 1 });
    expect(clock).toBeGreaterThanOrEqual(T0 + 30 * MIN);
    expect(clock).toBeLessThan(T0 + 32 * MIN);
  });
});

describe("runs queued behind a full agent slot cap", () => {
  const agents = [{ id: "a1", runtimeConfig: { heartbeat: { maxConcurrentRuns: 2 } } }];
  const rows = (list: Json[]) => list.map(runRow);
  const queued = (list: Json[], at: number) => {
    const runs = rows(list);
    return slotQueuedRuns(runs, at, hostedQueueWait(["a1"], agents, runs));
  };

  it("counts a never-started run as slot-queued only while the running runs fill the cap with no idle slot since it was created", () => {
    const full = [apiRun("h1", "i1", T0, T0), apiRun("h2", "i2", T0 + MIN, T0 + MIN), apiRun("q1", "i3", T0 + 2 * MIN, null)];
    expect([...queued(full, T0 + 8 * MIN)]).toEqual(["q1"]);
    const oneRunning = [apiRun("h1", "i1", T0, T0), apiRun("h2", "i2", T0 + MIN, T0 + MIN, { status: "succeeded", finishedAt: iso(T0 + 3 * MIN) }),
      apiRun("q1", "i3", T0 + 2 * MIN, null)];
    expect([...queued(oneRunning, T0 + 8 * MIN)]).toEqual([]);
    const refilledLate = [...oneRunning, apiRun("h3", "i4", T0 + 6 * MIN, T0 + 6 * MIN, { invocationSource: "on_demand" })];
    expect([...queued(refilledLate, T0 + 8 * MIN)]).toEqual([]);
    const overtaken = [apiRun("h1", "i1", T0, T0), apiRun("h2", "i2", T0 + MIN, T0 + MIN, { status: "succeeded", finishedAt: iso(T0 + 3 * MIN) }),
      apiRun("q1", "i3", T0 + 2 * MIN, null), apiRun("h3", "i4", T0 + 2.5 * MIN, T0 + 3 * MIN)];
    expect([...queued(overtaken, T0 + 8 * MIN)]).toEqual([]);
    expect([...slotQueuedRuns(rows(full), T0 + 8 * MIN, hostedQueueWait(["a1"], [{ id: "a1", runtimeConfig: null }], rows(full)))]).toEqual([]);
  });

  it("leaves a task to the grade unless every live run of it is slot-queued and it is still open", () => {
    const runs = rows([apiRun("q1", "i3", T0, null), apiRun("r9", "i3", T0, T0)]);
    expect(queuedBehindSlotCap("todo", runs.slice(0, 1), new Set(["q1"]))).toBe(true);
    expect(queuedBehindSlotCap("todo", runs, new Set(["q1"]))).toBe(false);
    expect(queuedBehindSlotCap("blocked", runs.slice(0, 1), new Set(["q1"]))).toBe(false);
    expect(queuedBehindSlotCap("todo", [], new Set(["q1"]))).toBe(false);
    const failedFirst = rows([apiRun("q1", "i3", T0, null), apiRun("f1", "i3", T0 - MIN, T0 - MIN, { status: "failed", finishedAt: iso(T0) })]);
    expect(queuedBehindSlotCap("todo", failedFirst, new Set(["q1"]))).toBe(false);
  });
});

describe("hosted grade at the cutoff", () => {
  const grade = async (input: { runs: Json[] | ((clock: number) => Json[]); issues: Json[]; tasks: HostedTaskRecord[]; cap: number; start: number; viewMs: number }) => {
    let clock = input.start;
    const views = new Map(input.issues.map(issue => [`/api/issues/${issue.id}`, issue]));
    const api = {
      get: async <T>(route: string): Promise<T> => {
        if (route.includes("/heartbeat-runs?")) { clock += 1_000; return (typeof input.runs === "function" ? input.runs(clock) : input.runs) as T; }
        if (route.includes("/issues?")) return input.issues as T;
        if (route.endsWith("/agents")) return [{ id: "a1", runtimeConfig: { heartbeat: { maxConcurrentRuns: input.cap } } }] as T;
        if (views.has(route)) { clock += input.viewMs; return views.get(route) as T; }
        if (route.includes("assigned-work-invariant")) throw new Error("GET returned 404");
        return [] as T;
      },
      post: async <T>() => ({}) as T,
    };
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-cutoff-"));
    dirs.push(dir);
    const events: string[] = [];
    const graded = await gradeHosted({ api, companyId: "c1", agentIds: ["a1"], releases: [], health: () => continuity([]), apiContinuity: () => continuity([]),
      stopObserver: async () => {}, observedClicks: () => new Map(), lastReleaseAt: input.start - 1_000, settleMs: 1, drainMs: 1, dir, cancelled: () => false,
      record: kind => events.push(kind), pollMs: 1, now: () => clock, quietMs: 90_000, tasks: () => input.tasks, wantedReleases: 0 });
    return { graded, events, json: JSON.parse(await readFile(path.join(dir, "hosted-release-swap.json"), "utf8")) };
  };

  it("measures run activity against the moment the runs were read, not after minutes of task view reads", async () => {
    const start = T0 + 10 * MIN;
    const issues = [{ id: "i1", identifier: "GIT-740", title: "t", status: "in_progress", assigneeAgentId: "a1", createdAt: iso(T0) },
      ...Array.from({ length: 8 }, (_, n) => ({ id: `d${n}`, identifier: `GIT-${n}`, title: "d", status: "done", assigneeAgentId: "a1", createdAt: iso(T0), completedAt: iso(T0 + MIN) }))];
    const runs = (clock: number) => [apiRun("r1", "i1", T0, T0, { updatedAt: iso(clock - MIN) }),
      ...issues.slice(1).map((issue, n) => apiRun(`f${n}`, issue.id, T0, T0, { status: "succeeded", finishedAt: iso(T0 + MIN), updatedAt: iso(T0 + MIN) }))];
    const { json } = await grade({ runs, issues, tasks: [], cap: 5, start, viewMs: MIN });
    const grade740 = json.grades.find((entry: Json) => entry.identifier === "GIT-740");
    expect(grade740).toMatchObject({ verdict: "still_working", label: null });
  });

  it("does not grade subtasks still queued behind the agent's full slot cap, and fails the gate on the slot holders still running", async () => {
    const start = T0 + 12 * MIN;
    const issues = [
      { id: "p1", identifier: "GIT-743", title: "parent", status: "in_progress", assigneeAgentId: "a1", createdAt: iso(T0) },
      { id: "c1", identifier: "GIT-744", title: "SM sub 1", status: "todo", parentId: "p1", assigneeAgentId: "a1", createdAt: iso(T0 + 3 * MIN) },
      { id: "c2", identifier: "GIT-745", title: "SM sub 2", status: "todo", parentId: "p1", assigneeAgentId: "a1", createdAt: iso(T0 + 3 * MIN) },
    ];
    const runs = [apiRun("rp", "p1", T0, T0, { updatedAt: iso(start) }), apiRun("q1", "c1", T0 + 3 * MIN, null), apiRun("q2", "c2", T0 + 3 * MIN, null)];
    const { graded, events, json } = await grade({ runs, issues, tasks: [planned("p1", "GIT-743", T0)], cap: 1, start, viewMs: 0 });
    expect(json.notGraded).toEqual([{ issueId: "c1", identifier: "GIT-744", runIds: ["q1"] }, { issueId: "c2", identifier: "GIT-745", runIds: ["q2"] }]);
    expect(json.grades.map((entry: Json) => entry.identifier)).toEqual(["GIT-743"]);
    expect(json.r1.map((entry: Json) => entry.identifier)).toEqual(["GIT-743"]);
    expect(events).toContain("hosted_not_graded_slot_queued");
    expect(graded.markdown).toContain("Not graded: 2 task(s) still queued behind a full agent slot cap");
    expect(graded.pass).toBe(false);
  });

  it("grades a queued subtask when the agent had a free slot, so a real stall still fails", async () => {
    const start = T0 + 12 * MIN;
    const issues = [{ id: "p1", identifier: "GIT-743", title: "parent", status: "in_progress", assigneeAgentId: "a1", createdAt: iso(T0) },
      { id: "c1", identifier: "GIT-744", title: "SM sub 1", status: "todo", parentId: "p1", assigneeAgentId: "a1", createdAt: iso(T0 + 3 * MIN) }];
    const runs = [apiRun("rp", "p1", T0, T0, { updatedAt: iso(start) }), apiRun("q1", "c1", T0 + 3 * MIN, null)];
    const { json } = await grade({ runs, issues, tasks: [planned("p1", "GIT-743", T0)], cap: 2, start, viewMs: 0 });
    expect(json.notGraded).toEqual([]);
    expect(json.grades.find((entry: Json) => entry.identifier === "GIT-744")).toMatchObject({ verdict: "open_no_owner", label: "nothing pending" });
  });
});

describe("the loop-guard notice", () => {
  it("is informational when each copy came from a different run, and a duplicate otherwise", async () => {
    expect(isNoticeRepeat(LOOP_GUARD_NOTICE, ["r1", "r2"])).toBe(true);
    expect(isNoticeRepeat(LOOP_GUARD_NOTICE, ["r1", "r1"])).toBe(false);
    expect(isNoticeRepeat(LOOP_GUARD_NOTICE, ["r1", null])).toBe(false);
    expect(isNoticeRepeat(LOOP_GUARD_NOTICE, [])).toBe(false);
    expect(isNoticeRepeat("DONE-c5164d03", ["r1", "r2"])).toBe(false);
    expect(isNoticeRepeat("Prepared Ledger log for this response.", [null, null])).toBe(true);
    const comments: Record<string, Json[]> = {
      "/api/issues/i1/comments": [{ authorAgentId: "a1", createdByRunId: "r1", body: LOOP_GUARD_NOTICE }, { authorAgentId: "a1", createdByRunId: "r2", body: LOOP_GUARD_NOTICE }],
      "/api/issues/i2/comments": [{ authorAgentId: "a1", createdByRunId: "r3", body: LOOP_GUARD_NOTICE }, { authorAgentId: "a1", createdByRunId: "r3", body: LOOP_GUARD_NOTICE }],
    };
    const api = { get: async <T>(route: string) => (comments[route] ?? []) as T };
    expect(await duplicateAgentComments(api, ["i1", "i2"])).toEqual({ duplicateComments: [{ issueId: "i2", count: 2 }], autoNoticeRepeats: [{ issueId: "i1", count: 2 }] });
  });
});
