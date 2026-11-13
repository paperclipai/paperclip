import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeHosted, releaseWindows } from "./hosted-grade.js";
import {
  duplicateAgentComments, duplicateChildren, failureChain, hostedCompanyRuns, hostedIssues, issueViewFields, pendingPersonItems, runRow, startedIssues,
} from "./hosted-readers.js";
import { cleanupHosted, pickEnvironment } from "./hosted-setup.js";
import { detectReleases } from "./hosted-release.js";

type Json = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function fakeApi(routes: Record<string, unknown | ((route: string) => unknown)>, writes: Array<{ method: string; route: string; body?: unknown }> = []) {
  const read = (route: string) => {
    const key = Object.keys(routes).find(candidate => route === candidate || route.startsWith(`${candidate}?`));
    if (key === undefined) throw new Error(`GET ${route} returned 404`);
    const value = routes[key];
    return typeof value === "function" ? (value as (route: string) => unknown)(route) : value;
  };
  return {
    get: async <T>(route: string) => read(route) as T,
    post: async <T>(route: string, body?: unknown) => { writes.push({ method: "POST", route, body }); return (route.endsWith("/retry") ? { accepted: true } : {}) as T; },
    patch: async <T>(route: string, body?: unknown) => { writes.push({ method: "PATCH", route, body }); return {} as T; },
    delete: async (route: string) => { writes.push({ method: "DELETE", route }); },
  };
}

const run = (overrides: Json): Json => ({ id: "r1", agentId: "a1", issueId: "i1", status: "succeeded", errorCode: null, error: null,
  createdAt: "2026-11-12T17:00:00.000Z", startedAt: "2026-11-12T17:00:01.000Z", finishedAt: "2026-11-12T17:10:00.000Z",
  updatedAt: "2026-11-12T17:10:00.000Z", lastOutputAt: null, ...overrides });

describe("hosted API readers", () => {
  it("maps run rows from the company run list, keeps only the harness's agents, and never claims an owning server process", async () => {
    const api = fakeApi({ "/api/companies/c1/heartbeat-runs": (route: string) => route.includes("agentId=a1")
      ? [run({}), run({ id: "foreign", agentId: "someone-else" }), run({ id: "r2", issueId: null, contextSnapshot: { issueId: "i2" }, status: "running",
        finishedAt: null, lastOutputAt: "2026-11-12T17:20:00.000Z" })] : [] });
    const rows = await hostedCompanyRuns(api, "c1", ["a1"]);
    expect(rows.map(row => row.runId)).toEqual(["r1", "r2"]);
    expect(rows[1]).toMatchObject({ issueId: "i2", status: "running", finishedAt: null, lastActivityAt: Date.parse("2026-11-12T17:20:00.000Z"), ownerPid: null });
    expect(runRow(run({ error: "x".repeat(900) })).error).toHaveLength(400);
  });

  it("lists the harness's tasks, counts only ones that had a run, and reads a person's wait from interactions and approvals", async () => {
    const api = fakeApi({
      "/api/companies/c1/issues": [{ id: "i1", identifier: "PC-1", title: "[rc] a", status: "done", assigneeAgentId: "a1" },
        { id: "i2", title: "[rc] b", status: "blocked", assigneeAgentId: "a1" }, { id: "i3", title: "never ran", status: "todo", assigneeAgentId: "a1" },
        { id: "i4", title: "hidden", status: "todo", assigneeAgentId: "a1", hiddenAt: "2026-11-12T00:00:00Z" },
        { id: "x1", title: "not ours", status: "todo", assigneeAgentId: "other" }],
      "/api/issues/i1/interactions": [], "/api/issues/i1/approvals": [],
      "/api/issues/i2/interactions": [{ status: "pending" }], "/api/issues/i2/approvals": [{ status: "approved" }],
      "/api/issues/i4/interactions": () => { throw new Error("boom"); },
    });
    const issues = await hostedIssues(api, "c1", ["a1"]);
    expect(issues.map(issue => issue.id)).toEqual(["i1", "i2", "i3", "i4"]);
    const started = startedIssues(issues, [runRow(run({})), runRow(run({ id: "r2", issueId: "i2" })), runRow(run({ id: "r4", issueId: "i4" }))]);
    expect(started.map(issue => issue.id)).toEqual(["i1", "i2"]);
    const person = await pendingPersonItems(api, ["i1", "i2", "i4"]);
    expect([...person.questions]).toEqual(["i2"]);
    expect([...person.approvals]).toEqual([]);
    expect(person.unreadable).toEqual(["i4"]);
  });

  it("reads the same task view fields the local grade reads, failure chains, and duplicated side effects", async () => {
    expect(issueViewFields({ status: "todo", scheduledRetry: true, interruption: { state: "failed", canRetry: true, userAction: "choose_model",
      responsibility: "user", providerFailure: { category: "rate_limit" } }, activeRecoveryAction: { ownerType: "board" }, executionBlocker: { code: "x" },
      blockedBy: [{ status: "done" }, { status: "todo" }] })).toEqual({ status: "todo", scheduledRetry: true, interruption: { state: "failed", canRetry: true,
      retryWait: false, userAction: "choose_model", responsibility: "user", providerFailureCategory: "rate_limit" }, activeRecoveryOwner: "board", executionBlocker: true, openBlockers: 1 });
    const api = fakeApi({
      "/api/heartbeat-runs/r9/events": [{ eventType: "run.started", level: "info" }, { eventType: "runner.lost", level: "error", message: "process gone" }],
      "/api/issues/i1/comments": [{ authorAgentId: "a1", body: "DONE-x" }, { authorAgentId: "a1", body: "DONE-x" }, { authorUserId: "u", body: "DONE-x" }],
    });
    expect(await failureChain(api, "r9")).toEqual(["runner.lost: process gone"]);
    expect(await duplicateAgentComments(api, ["i1"])).toEqual({ duplicateComments: [{ issueId: "i1", count: 2 }], autoNoticeRepeats: [] });
    expect(duplicateChildren([{ id: "s1", identifier: null, title: "SM sub 1", status: "done", parentId: "p", assigneeAgentId: "a1", hidden: false },
      { id: "s2", identifier: null, title: "SM sub 1", status: "done", parentId: "p", assigneeAgentId: "a1", hidden: false }])).toEqual([{ parentId: "p", title: "SM sub 1", count: 2 }]);
  });

  it("grades every started task with the release-swap grade over the API, clicks Retry where offered and labels each failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-grade-"));
    dirs.push(dir);
    const writes: Array<{ method: string; route: string; body?: unknown }> = [];
    let retried = false;
    const api = fakeApi({
      "/api/companies/c1/heartbeat-runs": () => [run({ id: "r1", issueId: "i1" }), run({ id: "r2", issueId: "i2", status: "failed", errorCode: "process_lost" }),
        run({ id: "r3", issueId: "i3", status: "failed", errorCode: "controller_lease_lost" }),
        ...(retried ? [run({ id: "r4", issueId: "i2", createdAt: new Date().toISOString() })] : [])],
      "/api/companies/c1/issues": [{ id: "i1", title: "a", status: "done", assigneeAgentId: "a1" }, { id: "i2", title: "b", status: "todo", assigneeAgentId: "a1" },
        { id: "i3", title: "c", status: "in_progress", assigneeAgentId: "a1" }],
      "/api/issues/i1": { status: "done" },
      "/api/issues/i2": () => retried ? { status: "done" } : { status: "todo", interruption: { state: "failed", canRetry: true, observedRunId: "r2" } },
      "/api/issues/i3": { status: "in_progress" },
      "/api/issues/i1/interactions": [], "/api/issues/i2/interactions": [], "/api/issues/i3/interactions": [],
      "/api/issues/i1/approvals": [], "/api/issues/i2/approvals": [], "/api/issues/i3/approvals": [],
      "/api/issues/i1/comments": [], "/api/issues/i2/comments": [], "/api/issues/i3/comments": [],
      "/api/heartbeat-runs/r2/events": [], "/api/heartbeat-runs/r3/events": [], "/api/heartbeat-runs/r4/events": [],
    }, writes);
    const post = api.post;
    api.post = async <T>(route: string, body?: unknown) => { if (route.endsWith("/retry")) retried = true; return post<T>(route, body); };
    const releases = detectReleases([{ at: 0, ok: true, status: 200, ms: 1, processStartedAt: "a", commit: "x" },
      { at: 1_000, ok: true, status: 200, ms: 1, processStartedAt: "b", commit: "y" }], { now: 1_000_000 });
    let latestApi = { requests: 0, failures: 0, slow: 0, longestGapMs: 0, longestGap: null as { from: number; to: number } | null };
    const graded = await gradeHosted({ api, companyId: "c1", agentIds: ["a1"], releases, health: () => ({ requests: 2, failures: 0, slow: 0, longestGapMs: 1_000, longestGap: null }),
      apiContinuity: () => latestApi, stopObserver: async () => { latestApi = { requests: 9, failures: 3, slow: 1, longestGapMs: 4_000, longestGap: { from: 0, to: 4_000 } }; }, observedClicks: () => new Map(), lastReleaseAt: Date.now() - 10_000,
      settleMs: 5, drainMs: 5, dir, cancelled: () => false, record: () => {}, pollMs: 5 });
    expect(writes.filter(write => write.route.endsWith("/retry"))).toEqual([{ method: "POST", route: "/api/issues/i2/retry", body: { idempotencyKey: expect.any(String), observedRunId: "r2" } }]);
    expect(graded.headline).toBe("1 / 3 tasks completed hands-off");
    expect(graded.markdown.split("\n").slice(0, 4)).toEqual(["1 / 3 tasks completed hands-off", "Retry banner shown: 1 (cleared by itself: 0)",
      "Retry worked / clicked: 1 / 1", "Assigned-work invariant: not available on this build (HTTP no answer)."]);
    expect(graded.pass).toBe(false);
    const json = JSON.parse(await readFile(path.join(dir, "hosted-release-swap.json"), "utf8"));
    expect(json.result.byLabel).toEqual({ "needed Retry (click worked)": 1, "nothing pending": 1 });
    expect(json.failedRuns.map((failed: Json) => [failed.runId, failed.release])).toEqual([["r2", null], ["r3", null]]);
    expect(graded.markdown).toContain("Failed outside a release window (more than 15 min after a stop and not live at it): r2, r3.");
    expect(graded.markdown).toContain("Unavailable over the API:");
    expect(graded.markdown).toContain("API requests: 9 requests, 3 failed, 1 slow, longest gap between answers 4.0 s.");
    expect(json.api).toMatchObject({ requests: 9, failures: 3 });
    expect(releaseWindows(releases)[0]).toMatchObject({ index: 1, spawnedAt: 1_000, fromPid: null });
  });

  it("picks the company's sandbox environment over other remote drivers, or asks for one", async () => {
    const both = fakeApi({ "/api/companies/c1/environments": [{ id: "local", driver: "local" }, { id: "computer", driver: "plugin" }, { id: "box", driver: "sandbox" }] });
    expect(await pickEnvironment(both, "c1", null)).toBe("box");
    expect(await pickEnvironment(both, "c1", "computer")).toBe("computer");
    const two = fakeApi({ "/api/companies/c1/environments": [{ id: "a", driver: "sandbox" }, { id: "b", driver: "sandbox" }] });
    await expect(pickEnvironment(two, "c1", null)).rejects.toThrow(/--hosted-environment/);
  });

  it("cleans up only what carries the run label: pauses and removes its agents, cancels their live runs, archives their tasks, deletes its secrets", async () => {
    const writes: Array<{ method: string; route: string; body?: unknown }> = [];
    const api = fakeApi({
      "/api/companies/c1/agents": [{ id: "a1", name: "RC rc-x opencode" }, { id: "other", name: "Someone's agent" }, { id: "a9", name: "RC rc-xy opencode" }],
      "/api/companies/c1/heartbeat-runs": (route: string) => route.includes("agentId=a1") ? [run({ status: "running" }), run({ id: "f", agentId: "other", status: "running" })] : [],
      "/api/companies/c1/issues": (route: string) => route.includes("assigneeAgentId=a1") ? [{ id: "i1", assigneeAgentId: "a1" }, { id: "x", assigneeAgentId: "other" }] : [],
      "/api/companies/c1/secrets": [{ id: "s1", name: "restart-chaos rc-x OPENROUTER_API_KEY" }, { id: "s2", name: "OPENROUTER_API_KEY" }, { id: "s3", name: "restart-chaos rc-xy OPENROUTER_API_KEY" }],
      "/api/companies/c1/projects": [{ id: "p1", name: "Restart chaos rc-x" }, { id: "p2", name: "Real project" }],
      "/api/agents/a1": { id: "a1", status: "terminated" },
    }, writes);
    const report = await cleanupHosted({ api, label: "rc-x", companyId: "c1", state: null, record: () => {} });
    expect(writes.map(write => `${write.method} ${write.route}`)).toEqual(["PATCH /api/agents/a1", "POST /api/heartbeat-runs/r1/cancel", "PATCH /api/issues/i1",
      "DELETE /api/agents/a1", "DELETE /api/secrets/s1", "PATCH /api/projects/p1"]);
    expect(report).toMatchObject({ runsCancelled: 1, tasksArchived: 1, agentsPaused: 1, agentsRemoved: 1, secretsDeleted: 1, projectArchived: true, errors: [] });
  });
});
