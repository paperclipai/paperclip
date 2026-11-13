import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChaosApiError } from "./api.js";
import { HostedApi, requestSamples } from "./hosted-api.js";
import { parseHostedCommand } from "./hosted-config.js";
import { gradeHosted } from "./hosted-grade.js";
import { hostedTarget } from "./hosted-guard.js";
import { arrivalsDone, finalizeHosted, keepPolling, observedClicks } from "./hosted-main.js";
import { hostedCompanyRuns, hostedIssues, runEvents, RUN_PAGE, ISSUE_PAGE, EVENT_PAGE } from "./hosted-readers.js";
import { continuity } from "./hosted-release.js";
import { cleanupHosted, setupHosted, statePath } from "./hosted-setup.js";
import type { HostedTaskRecord } from "./hosted-workload.js";

type Json = Record<string, any>;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const tempDir = async () => { const dir = await mkdtemp(path.join(os.tmpdir(), "hosted-main-")); dirs.push(dir); return dir; };
const host = "release-proof-1.staging.paperclip.app";

describe("hosted run control", () => {
  it("ends a fixed batch only when the plan is used up and no task is in flight", () => {
    expect(arrivalsDone(0, 5, 0, [])).toBe(false);
    expect(arrivalsDone(0, 0, 1, [])).toBe(false);
    expect(arrivalsDone(0, 0, 0, [])).toBe(true);
    expect(arrivalsDone(2, 0, 0, [])).toBe(false);
  });

  it("stops the observer before the grade reads Retry clicks, so a click during the drain fails the task", async () => {
    const dir = await tempDir();
    const record = { issueId: "i1", retryClicks: [] } as unknown as HostedTaskRecord;
    const api = {
      get: async <T>(route: string) => (route.includes("heartbeat-runs") ? [{ id: "r1", agentId: "a1", issueId: "i1", status: "succeeded", createdAt: 1, startedAt: 2, finishedAt: 3 }]
        : route.includes("/issues?") ? [{ id: "i1", title: "a", status: "done", assigneeAgentId: "a1" }] : route === "/api/issues/i1" ? { status: "done" } : []) as T,
      post: async <T>() => ({}) as T,
    };
    let stopped = false;
    const graded = await gradeHosted({ api, companyId: "c1", agentIds: ["a1"], releases: [], health: () => continuity([]), apiContinuity: () => continuity([]),
      stopObserver: async () => { stopped = true; record.retryClicks.push({ at: 0, accepted: true, via: "observer" }); },
      observedClicks: () => observedClicks([record]), lastReleaseAt: Date.now() - 1_000, settleMs: 5, drainMs: 5, dir, cancelled: () => false, record: () => {}, pollMs: 5 });
    expect(stopped).toBe(true);
    expect(graded.headline).toBe("0 / 1 tasks completed hands-off");
  });

  it("stops background polling promptly and never polls after stop", async () => {
    let polls = 0;
    const polling = keepPolling({ poll: async () => { polls += 1; } }, 60_000);
    await new Promise(resolve => setTimeout(resolve, 20));
    const started = Date.now();
    await polling.stop();
    const after = polls;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(polls).toBe(after);
  });

  it("cleans up what a failed setup already created, from the saved state, keeping a terminated agent that has cost history", async () => {
    const dir = await tempDir();
    const writes: string[] = [];
    let agentStatus = "idle";
    let lifecycleReads = 0;
    const api = {
      get: async <T>(route: string) => {
        if (route.endsWith("/environments")) return [{ id: "e1", driver: "sandbox" }] as T;
        if (route.endsWith("/agents")) return [{ id: "a1", name: "RC rc-x opencode" }] as T;
        if (route === "/api/agents/a1") return { id: "a1", status: agentStatus, lifecycleState: agentStatus === "terminated" && lifecycleReads++ > 0 ? "terminated" : "terminating" } as T;
        if (route.endsWith("/secrets")) return [{ id: "s1", name: "restart-chaos rc-x OPENROUTER_API_KEY" }] as T;
        if (route.endsWith("/projects")) return [{ id: "p1", name: "Restart chaos rc-x" }] as T;
        return [] as T;
      },
      post: async <T>(route: string) => {
        writes.push(`POST ${route}`);
        if (route.endsWith("/secrets")) return { id: "s1" } as T;
        if (route.endsWith("/projects")) return { id: "p1" } as T;
        if (route.endsWith("/terminate")) { agentStatus = "terminated"; return {} as T; }
        throw new Error("agent creation failed");
      },
      patch: async <T>(route: string) => { writes.push(`PATCH ${route}`); return {} as T; },
      delete: async (route: string) => {
        writes.push(`DELETE ${route}`);
        if (route === "/api/agents/a1") throw new ChaosApiError(409, `DELETE ${route} returned 409: {"code":"agent_cost_history_retained"}`);
      },
    };
    const options = parseHostedCommand(["--hosted-base-url", `https://${host}`, "--hosted-allow", host, "--hosted-label", "rc-x"]);
    await expect(setupHosted({ api, options, companyId: "c1", dir, env: { OPENROUTER_API_KEY: "k" }, record: () => {} })).rejects.toThrow(/agent creation failed/);
    expect(JSON.parse(await readFile(statePath(dir), "utf8"))).toMatchObject({ companyId: "c1", projectId: "p1", secrets: [{ id: "s1" }] });
    writes.length = 0;
    expect(await finalizeHosted({ api, keep: false, label: "rc-x", dir, state: null, record: () => {}, terminatePollMs: 1 })).toMatchObject({ errors: [] });
    expect(lifecycleReads).toBeGreaterThan(1);
    expect(writes).toEqual(["PATCH /api/agents/a1", "POST /api/agents/a1/terminate", "DELETE /api/agents/a1", "DELETE /api/secrets/s1", "PATCH /api/projects/p1"]);
    expect(await finalizeHosted({ api, keep: true, label: "rc-x", dir, state: null, record: () => {} })).toBeNull();
  });
  it("collects every page of a run agent's tasks before hiding any, so none is skipped as the list shrinks", async () => {
    const hidden = new Set<string>();
    const tasks = Array.from({ length: ISSUE_PAGE + 7 }, (_, index) => ({ id: `t${index}`, assigneeAgentId: "a1" }));
    const api = {
      get: async <T>(route: string) => {
        if (route.endsWith("/agents")) return [{ id: "a1", name: "RC rc-x opencode", status: "terminated" }] as T;
        if (route.includes("/issues?")) { const offset = Number(/offset=(\d+)/.exec(route)![1]); return tasks.filter(task => !hidden.has(task.id)).slice(offset, offset + ISSUE_PAGE) as T; }
        if (route === "/api/agents/a1") return { id: "a1", status: "terminated" } as T;
        return [] as T;
      },
      post: async <T>() => ({}) as T,
      patch: async <T>(route: string) => { hidden.add(route.split("/").at(-1)!); return {} as T; },
      delete: async () => {},
    };
    const report = await cleanupHosted({ api, label: "rc-x", companyId: "c1", state: null, record: () => {} });
    expect(report).toMatchObject({ tasksArchived: ISSUE_PAGE + 7, errors: [] });
    expect(hidden.size).toBe(ISSUE_PAGE + 7);
  });

  it("reports a cleanup read that failed instead of counting the object as removed", async () => {
    const writes: string[] = [];
    const unavailable = (route: string) => new ChaosApiError(503, `GET ${route} returned 503`);
    const api = {
      get: async <T>(route: string) => {
        if (route.endsWith("/agents")) return [{ id: "a1", name: "RC rc-x opencode", status: "paused" }] as T;
        if (route === "/api/agents/a1" || route.endsWith("/secrets")) throw unavailable(route);
        return [] as T;
      },
      post: async <T>(route: string) => { writes.push(`POST ${route}`); return {} as T; },
      patch: async <T>(route: string) => { writes.push(`PATCH ${route}`); return {} as T; },
      delete: async (route: string) => { writes.push(`DELETE ${route}`); },
    };
    const report = await cleanupHosted({ api, label: "rc-x", companyId: "c1", state: null, record: () => {} });
    expect(report.agentsRemoved).toBe(0);
    expect(report.errors).toEqual([expect.stringMatching(/^remove agent a1: GET \/api\/agents\/a1 returned 503/), expect.stringMatching(/^read secrets: /)]);
    expect(writes).toEqual(["PATCH /api/agents/a1"]);
  });
});

describe("hosted readers collect complete history", () => {
  it("pages through tasks and run events, and falls back to per-task runs when the company run list is full", async () => {
    const issues = Array.from({ length: ISSUE_PAGE + 3 }, (_, index) => ({ id: `i${index}`, title: "t", status: "done", assigneeAgentId: "a1" }));
    const seen: string[] = [];
    const api = { get: async <T>(route: string) => {
      seen.push(route);
      if (route.includes("/issues?")) { const offset = Number(/offset=(\d+)/.exec(route)![1]); return issues.slice(offset, offset + ISSUE_PAGE) as T; }
      if (route.includes("heartbeat-runs?")) return Array.from({ length: RUN_PAGE }, (_, index) => ({ id: `r${index}`, agentId: "a1", issueId: "i1", status: "succeeded" })) as T;
      if (route === "/api/issues/i0/runs") return [{ runId: "old", agentId: "a1", status: "failed", errorCode: "process_lost" }, { runId: "foreign", agentId: "x", status: "failed" }] as T;
      if (route.startsWith("/api/issues/")) return [] as T;
      if (route.includes("/events?")) { const after = Number(/afterSeq=(\d+)/.exec(route)![1]); return (after < EVENT_PAGE
        ? Array.from({ length: EVENT_PAGE }, (_, index) => ({ seq: after + index + 1, createdAt: index })) : [{ seq: after + 1, createdAt: 9 }]) as T; }
      return [] as T;
    } };
    expect(await hostedIssues(api, "c1", ["a1"])).toHaveLength(ISSUE_PAGE + 3);
    const runs = await hostedCompanyRuns(api, "c1", ["a1"]);
    expect(runs).toHaveLength(RUN_PAGE + 1);
    expect(runs.find(run => run.runId === "old")).toMatchObject({ issueId: "i0", status: "failed", errorCode: "process_lost" });
    expect(runs.some(run => run.runId === "foreign")).toBe(false);
    expect(await runEvents(api, "r1")).toHaveLength(EVENT_PAGE + 1);
  });

  it("counts a refused request as a failure in continuity, not only server errors", async () => {
    const statuses = [200, 401, 404, 429, 503];
    const api = new HostedApi(hostedTarget(`https://${host}`, host), "t", 1_000, (async () => new Response("{}", { status: statuses.shift()! })) as unknown as typeof fetch);
    await api.get("/api/health");
    await api.get("/api/health").catch(() => undefined);
    expect(continuity(requestSamples(api.requests)).failures).toBeGreaterThanOrEqual(1);
    expect(api.requests[1]).toMatchObject({ ok: false, reachable: true, status: 401 });
    await api.get("/api/companies/c1/assigned-work-invariant").catch(() => undefined);
    expect(api.requests[2]).toMatchObject({ ok: true, status: 404 });
  });
});
