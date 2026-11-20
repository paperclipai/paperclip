import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedApi, pathClass, requestBreakdown, type RequestRecord } from "./hosted-api.js";
import { hostedTarget } from "./hosted-guard.js";
import { saveRequests } from "./hosted-main.js";
import { gradeHosted } from "./hosted-grade.js";
import { duplicateAgentComments } from "./hosted-readers.js";
import { continuity } from "./hosted-release.js";
import { drainState, failedOutsideSwaps, isAutoNotice, swapForFailedRun, swapMetrics, type SwapRunFact, type SwapWindow } from "./release-swap-grade.js";

type Json = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("end-of-wave drain", () => {
  it("is quiet only after no run was created or finished for the quiet period", () => {
    const finished = [{ status: "succeeded", createdAt: 0, finishedAt: 100_000, lastActivityAt: 100_000 }];
    expect(drainState(finished, 101_000, 300_000)).toMatchObject({ progressing: 0, quiet: false, lastChangeAt: 100_000 });
    expect(drainState(finished, 190_000, 300_000)).toMatchObject({ quiet: true });
    expect(drainState([...finished, { status: "running", createdAt: 120_000, finishedAt: null, lastActivityAt: 185_000 }], 220_000, 300_000))
      .toMatchObject({ progressing: 1, quiet: false });
    expect(drainState([], 0, 300_000, 0).quiet).toBe(true);
  });

  it("grades a parent by the continuation a children-completed wake creates 20 s after its run ends, not as nothing pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-drain-"));
    dirs.push(dir);
    const ended = 1_800_000_000_000;
    let clock = ended + 1_000;
    const done = ended + 200_000;
    const runs = () => [
      { id: "r1", agentId: "a1", issueId: "p1", status: "succeeded", createdAt: ended - 600_000, startedAt: ended - 590_000, finishedAt: ended, updatedAt: ended },
      ...(clock >= ended + 20_000 ? [{ id: "r2", agentId: "a1", issueId: "p1", status: clock >= done ? "succeeded" : "running", createdAt: ended + 20_000,
        startedAt: ended + 21_000, finishedAt: clock >= done ? done : null, updatedAt: Math.min(clock, done) }] : []),
    ];
    const api = {
      get: async <T>(route: string): Promise<T> => {
        if (route.includes("/heartbeat-runs?")) { clock += 10_000; return runs() as T; }
        if (route.includes("/issues?")) return [{ id: "p1", identifier: "GIT-87", title: "parent", status: clock >= done ? "done" : "in_progress", assigneeAgentId: "a1" }] as T;
        if (route === "/api/issues/p1") return { status: clock >= done ? "done" : "in_progress" } as T;
        if (route.includes("assigned-work-invariant")) throw new Error("GET returned 404");
        return [] as T;
      },
      post: async <T>() => ({}) as T,
    };
    const graded = await gradeHosted({ api, companyId: "c1", agentIds: ["a1"], releases: [], health: () => continuity([]), apiContinuity: () => continuity([]),
      stopObserver: async () => {}, observedClicks: () => new Map(), lastReleaseAt: ended - 1_000, settleMs: 1, drainMs: 3_600_000, dir,
      cancelled: () => false, record: () => {}, pollMs: 1, now: () => clock, quietMs: 90_000 });
    const json = JSON.parse(await readFile(path.join(dir, "hosted-release-swap.json"), "utf8"));
    expect(json.grades.map((grade: Json) => [grade.identifier, grade.verdict])).toEqual([["GIT-87", "pass"]]);
    expect(graded.headline).toBe("1 / 1 tasks completed hands-off");
    expect(clock).toBeGreaterThanOrEqual(done + 90_000);
  });
});

describe("duplicate agent comments", () => {
  it("counts the product's per-turn document notice apart from real repeated comments", async () => {
    expect(isAutoNotice("Prepared Ledger 6ec13502 for this response.")).toBe(true);
    expect(isAutoNotice("DONE-6ec13502")).toBe(false);
    const comments: Record<string, Json[]> = {
      "/api/issues/i1/comments": [{ authorAgentId: "a1", body: "Prepared Ledger log for this response." }, { authorAgentId: "a1", body: "Prepared Ledger log for this response." }],
      "/api/issues/i2/comments": [{ authorAgentId: "a1", body: "DONE-ab12" }, { authorAgentId: "a1", body: "DONE-ab12" }],
    };
    const api = { get: async <T>(route: string) => (comments[route] ?? []) as T };
    expect(await duplicateAgentComments(api, ["i1", "i2"])).toEqual({ duplicateComments: [{ issueId: "i2", count: 2 }], autoNoticeRepeats: [{ issueId: "i1", count: 2 }] });
  });
});

describe("request records", () => {
  it("classes paths without ids and breaks failures down by status and by release window", () => {
    expect(pathClass("/api/issues/0e59c55c-f956-42f4-b66f-078d8c8f354f/runs?view=recent")).toBe("/api/issues/:id/runs");
    const record = (at: number, status: number | null, ok = false): RequestRecord => ({ at, ok, reachable: status !== null && status < 500, status, ms: 10, method: "GET", kind: "api", path: "/api/issues/:id" });
    const breakdown = requestBreakdown([record(1_000, 503), record(1_500, null), record(9_000, 401), record(9_500, 200, true)], [{ from: 900, to: 2_000 }]);
    expect(breakdown).toMatchObject({ requests: 4, failures: 3, byStatus: { "503": 1, "no answer": 1, "401": 1 }, insideReleases: 2, outsideReleases: 1 });
    expect(breakdown.outside).toEqual([{ at: new Date(9_000).toISOString(), method: "GET", path: "/api/issues/:id", status: 401 }]);
  });
});

describe("failed runs per release", () => {
  const swaps: SwapWindow[] = [
    { index: 1, requestedAt: 1_000_000, spawnedAt: 1_270_000, stopRequestedAt: 1_000_000, stoppedAt: 1_000_000, fromPid: null },
    { index: 2, requestedAt: 4_000_000, spawnedAt: 4_048_000, stopRequestedAt: 4_000_000, stoppedAt: 4_000_000, fromPid: null },
  ];
  const fact = (runId: string, startedAt: number, finishedAt: number): SwapRunFact => ({ runId, issueId: "i", status: "failed", errorCode: "x", startedAt, finishedAt, ownerPidBeforeEnd: null });

  it("counts a run live at the stop or failing within 15 minutes of it, and lists the rest as outside any release", () => {
    const live = fact("live", 900_000, 1_840_000);
    const soon = fact("soon", 1_100_000, 1_600_000);
    const later = fact("later", 2_500_000, 2_540_000);
    expect(swapForFailedRun(swaps, live)).toBe(1);
    expect(swapForFailedRun(swaps, soon)).toBe(1);
    expect(swapForFailedRun(swaps, later)).toBeNull();
    expect(failedOutsideSwaps(swaps, [live, soon, later])).toEqual(["later"]);
    expect(swapMetrics(swaps, [live, soon, later], new Map(), 9_000_000).map(metric => metric.failedRuns)).toEqual([["live", "soon"], []]);
  });
});

describe("hosted request records", () => {
  it("saves every request, including ones made after the grade, from one final step", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-requests-"));
    dirs.push(dir);
    const records: RequestRecord[] = [{ at: 1, ok: true, reachable: true, status: 200, ms: 5, method: "GET", kind: "api", path: "/api/issues/:id" }];
    records.push({ at: 2, ok: true, reachable: true, status: 200, ms: 5, method: "PATCH", kind: "api", path: "/api/agents/:id" });
    await saveRequests(dir, records);
    expect((await readFile(path.join(dir, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).path)).toEqual(["/api/issues/:id", "/api/agents/:id"]);
  });

  it("keeps a run's requests when a later cleanup-only or observe-only call uses the same label", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-requests-"));
    dirs.push(dir);
    const record = (method: string): RequestRecord => ({ at: 1, ok: true, reachable: true, status: 200, ms: 5, method, kind: "api", path: "/api/agents/:id" });
    await saveRequests(dir, [record("GET")], "run");
    const cleanup = await saveRequests(dir, [record("DELETE")], "cleanup", new Date("2026-11-12T23:00:00.000Z"));
    expect(path.basename(cleanup)).toBe("requests-cleanup-2026-11-12T23-00-00-000Z.jsonl");
    expect(JSON.parse(await readFile(path.join(dir, "requests.jsonl"), "utf8")).method).toBe("GET");
    expect(JSON.parse(await readFile(cleanup, "utf8")).method).toBe("DELETE");
  });

  it("marks a health answer that is not a readable 200 as failed in the saved record too", async () => {
    const answers = [new Response("not json", { status: 200 }), new Response("{}", { status: 404 })];
    const api = new HostedApi(hostedTarget("https://release-proof-1.staging.paperclip.app", "release-proof-1.staging.paperclip.app"), "t", 1_000,
      (async () => answers.shift()!) as unknown as typeof fetch);
    expect((await api.health()).ok).toBe(false);
    expect((await api.health()).ok).toBe(false);
    expect(api.requests.map(record => [record.kind, record.status, record.ok])).toEqual([["health", 200, false], ["health", 404, false]]);
  });
});
