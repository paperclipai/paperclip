import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finishReleaseSwap, type ReleaseSwapFinishInput } from "./release-swap-finish.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function fakeDb(tables: { issues: Array<Record<string, unknown>>; runs: () => Array<Record<string, unknown>>; questions?: string[] }) {
  return { $client: { unsafe: async (sql: string) => {
    if (sql.includes("from issues i")) return tables.issues;
    if (sql.includes("issue_thread_interactions")) return (tables.questions ?? []).map(issueId => ({ issueId }));
    if (sql.includes("issue_approvals")) return [];
    if (sql.includes("agent_wakeup_requests")) return [];
    if (sql.includes("from heartbeat_runs r") && sql.includes("left(r.error")) return tables.runs();
    return [];
  } } } as unknown as ReleaseSwapFinishInput["db"];
}

async function finish(overrides: Partial<ReleaseSwapFinishInput>) {
  const waveDir = await mkdtemp(path.join(os.tmpdir(), "release-swap-finish-"));
  dirs.push(waveDir);
  const events: string[] = [];
  const result = await finishReleaseSwap({ driver: { swaps: [], drain: async () => {} }, settleMs: 200, companyId: "c1",
    api: { get: async () => ({}), post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"], db: fakeDb({ issues: [], runs: () => [] }),
    board: null, timeline: [], issueIdForTask: new Map(), serverWindows: [], waveDir, cancelled: () => false,
    record: kind => { events.push(kind); }, pollMs: 10, ...overrides });
  return { result, events, json: JSON.parse(await readFile(path.join(waveDir, "release-swap.json"), "utf8")) };
}

describe("release swap end-of-wave grade", () => {
  it("clicks Retry where the board offers it and grades the task as needing Retry, with the click working", async () => {
    let retried = false;
    const posts: Array<{ route: string; body: any }> = [];
    const api = {
      get: async (route: string) => route === "/api/issues/i2"
        ? (retried ? { status: "done" } : { status: "todo", interruption: { state: "failed", canRetry: true, observedRunId: "r2", responsibility: "user" } })
        : { status: "done" },
      post: async (route: string, body: any) => { posts.push({ route, body }); retried = true; return { accepted: true }; },
    } as unknown as ReleaseSwapFinishInput["api"];
    const runs = () => [
      { runId: "r1", issueId: "i1", status: "succeeded", createdAt: 1, startedAt: 2, finishedAt: 3, ownerPid: 10 },
      { runId: "r2", issueId: "i2", status: "failed", errorCode: "process_lost", createdAt: 1, startedAt: 2, finishedAt: 3, ownerPid: 10 },
      ...(retried ? [{ runId: "r3", issueId: "i2", status: "succeeded", createdAt: Date.now(), startedAt: Date.now(), finishedAt: Date.now(), ownerPid: 20 }] : []),
    ];
    const { result, events, json } = await finish({ api, db: fakeDb({ issues: [{ id: "i1", identifier: "CHA-1", title: "a" }, { id: "i2", identifier: "CHA-2", title: "b" }], runs }) });
    expect(posts).toEqual([{ route: "/api/issues/i2/retry", body: { idempotencyKey: expect.any(String), observedRunId: "r2" } }]);
    expect(result.headline).toBe("1 / 2 tasks completed without human action");
    expect(result.pass).toBe(false);
    expect(json.result.retry).toEqual({ tasks: 1, worked: 1, didNotWork: 0, pending: 0 });
    expect(json.grades.find((grade: any) => grade.issueId === "i2")).toMatchObject({ verdict: "needed_retry", status: "done" });
    expect(json.failedRuns[0]).toMatchObject({ runId: "r2", errorCode: "process_lost" });
    expect(events).toContain("release_swap_retry_clicked");
  });

  it("leaves a task whose view read failed out of the grade and marks the number incomplete", async () => {
    const api = { get: async (route: string) => { if (route === "/api/issues/u1") throw new Error("GET /api/issues/u1 unreachable: timeout"); return { status: "done" }; },
      post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"];
    const { result, events, json } = await finish({ api, db: fakeDb({ issues: [{ id: "d1", identifier: "CHA-1", title: "d" }, { id: "u1", identifier: "CHA-2", title: "u" }],
      runs: () => [{ runId: "r1", issueId: "d1", status: "succeeded" }, { runId: "r2", issueId: "u1", status: "succeeded" }] }) });
    expect(result).toMatchObject({ pass: false, headline: "1 / 1 tasks completed without human action (incomplete: 1 task(s) could not be read and are not counted)" });
    expect(json.grades.map((grade: any) => grade.issueId)).toEqual(["d1"]);
    expect(events).toContain("release_swap_views_unreadable");
  });

  it("waits out runs still making progress after the settle, up to the drain cap, before the single read", async () => {
    let reads = 0;
    const db = { $client: { unsafe: async (sql: string) => {
      if (sql.includes("from issues i")) return [{ id: "d1", identifier: "CHA-1", title: "d" }];
      if (sql.includes("left(r.error")) { reads += 1; return [{ runId: "r1", issueId: "d1", status: reads < 3 ? "running" : "succeeded", lastActivityAt: Date.now() }]; }
      return [];
    } } } as unknown as ReleaseSwapFinishInput["db"];
    const quiet = await finish({ db, drainCapMs: 60_000, api: { get: async () => ({ status: "done" }), post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"] });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(quiet.result.headline).toBe("1 / 1 tasks completed without human action");
    const busy = { $client: { unsafe: async (sql: string) => {
      if (sql.includes("from issues i")) return [{ id: "d1", identifier: "CHA-1", title: "d" }];
      if (sql.includes("left(r.error")) return [{ runId: "r1", issueId: "d1", status: "running", createdAt: 0, lastActivityAt: Date.now() }];
      return [];
    } } } as unknown as ReleaseSwapFinishInput["db"];
    const started = Date.now();
    const capped = await finish({ db: busy, drainCapMs: 400, api: { get: async () => ({ status: "in_progress" }), post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"] });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(capped.events).toContain("release_swap_drained");
    expect(capped.result.headline).toMatch(/^0 \/ 0 tasks completed without human action; 1 still running at the drain cap/);
    expect(capped.result.pass).toBe(false);
  });

  it("grades a pending question from the database as a person's wait, and passes a clean wave", async () => {
    const { json } = await finish({ api: { get: async () => ({ status: "blocked" }), post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"],
      db: fakeDb({ issues: [{ id: "q1", identifier: "CHA-3", title: "q" }], runs: () => [{ runId: "r1", issueId: "q1", status: "succeeded" }], questions: ["q1"] }) });
    expect(json.grades[0]).toMatchObject({ verdict: "waiting_on_person", personReason: "question" });
    const clean = await finish({ api: { get: async () => ({ status: "done" }), post: async () => ({}) } as unknown as ReleaseSwapFinishInput["api"],
      db: fakeDb({ issues: [{ id: "d1", identifier: "CHA-4", title: "d" }], runs: () => [{ runId: "r1", issueId: "d1", status: "succeeded" }] }) });
    expect(clean.result).toMatchObject({ headline: "1 / 1 tasks completed without human action", pass: true });
  });
});
