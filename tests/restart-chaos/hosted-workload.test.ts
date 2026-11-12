import { describe, expect, it } from "vitest";
import { HostedWorkload, inFlight, planHostedTasks, trackBanner, IDLE_RELEASE_MS } from "./hosted-workload.js";

describe("hosted staging-mix workload", () => {
  it("plans labelled tasks by the ratio and keeps only the concurrency in flight", async () => {
    const plans = planHostedTasks({ ratio: [["opencode", 100]], turnMinutes: [3, 3], subtaskShare: 0, followUpShare: 100, seed: 7 }, 4);
    expect(plans.map(plan => [plan.adapter, plan.task.rounds, plan.task.subtasks])).toEqual(Array(4).fill(["opencode", 2, 0]));
    const posts: Array<{ route: string; body: any }> = [];
    let issue = 0;
    const state = { status: "in_progress", runs: [{ status: "running" }] as Array<{ status: string }>, interruption: null as any };
    const api = {
      post: async <T>(route: string, body?: unknown) => { posts.push({ route, body }); issue += 1; return (route.endsWith("/retry") ? { accepted: true } : { id: `i${issue}`, identifier: `PC-${issue}` }) as T; },
      get: async <T>(route: string) => (route.endsWith("/runs") ? state.runs : { status: state.status, interruption: state.interruption }) as T,
    };
    const workload = new HostedWorkload({ api, label: "rc-x", companyId: "c1", projectId: "p1", agents: { opencode: { id: "a1", name: "RC rc-x opencode" } },
      plans, concurrency: 2, record: () => {}, retryDuringWave: true });
    expect(await workload.launchDue()).toBe(2);
    expect(posts.map(post => post.route)).toEqual(["/api/companies/c1/issues", "/api/companies/c1/issues"]);
    expect(posts[0]!.body).toMatchObject({ title: expect.stringMatching(/^\[rc-x\] Staging mix task [0-9a-f]{8}$/), assigneeAgentId: "a1", projectId: "p1", status: "todo" });
    expect(await workload.launchDue()).toBe(0);
    const later = Date.now() + 3 * 60_000;
    await workload.poll(later);
    expect(posts.filter(post => post.route.endsWith("/comments"))).toHaveLength(2);
    state.runs = [{ status: "failed" }];
    state.interruption = { canRetry: true, observedRunId: "r1" };
    await workload.poll(later + 1);
    await workload.poll(later + 2);
    expect(posts.filter(post => post.route.endsWith("/retry")).map(post => post.body.observedRunId)).toEqual(["r1", "r1"]);
    expect(workload.records[0]!.retryClicks).toEqual([{ at: later + 1, accepted: true, via: "observer" }]);
    state.status = "done";
    await workload.poll(later + 3);
    expect(workload.active(later + 3)).toHaveLength(0);
    expect(await workload.launchDue(later + 3)).toBe(2);
  });

  it("stops counting a task with no live run for ten minutes as in flight", () => {
    const record = { plan: {} as never, issueId: "i1", identifier: null, createdAt: 0, createError: null, status: "in_progress", lastLiveAt: 0,
      followUp: null, retryClicks: [], retriedRuns: [], banner: null, doneAt: null };
    expect(inFlight(record, IDLE_RELEASE_MS - 1)).toBe(true);
    expect(inFlight(record, IDLE_RELEASE_MS)).toBe(false);
    expect(inFlight({ ...record, status: "blocked" }, 1)).toBe(false);
  });

  it("by default never clicks Retry during the wave and records when the banner showed and whether it cleared by itself", async () => {
    const plans = planHostedTasks({ ratio: [["opencode", 100]], turnMinutes: [3, 3], subtaskShare: 0, followUpShare: 0, seed: 7 }, 1);
    const posts: string[] = [];
    const state = { status: "in_progress", interruption: { canRetry: true, observedRunId: "r1" } as any, runs: [{ status: "failed" }] as Array<{ status: string }> };
    const api = {
      post: async <T>(route: string) => { posts.push(route); return { id: "i1" } as T; },
      get: async <T>(route: string) => (route.endsWith("/runs") ? state.runs : { status: state.status, interruption: state.interruption }) as T,
    };
    const workload = new HostedWorkload({ api, label: "rc-x", companyId: "c1", projectId: null, agents: { opencode: { id: "a1", name: "n" } }, plans, concurrency: 1, record: () => {} });
    await workload.launchDue();
    const at = Date.now();
    await workload.poll(at);
    state.interruption = null;
    state.runs = [{ status: "running" }];
    await workload.poll(at + 1);
    expect(posts).toEqual(["/api/companies/c1/issues"]);
    expect(workload.records[0]!.retryClicks).toEqual([]);
    expect(workload.records[0]!.banner).toEqual({ firstShownAt: at, shown: false, clearedAt: at + 1, clearedByItself: true });
  });

  it("keeps the first time a banner showed when it shows again", () => {
    const first = trackBanner(null, true, 10).banner;
    const cleared = trackBanner(first, false, 20).banner;
    expect(trackBanner(cleared, true, 30).banner).toEqual({ firstShownAt: 10, shown: true, clearedAt: null, clearedByItself: false });
    expect(trackBanner(null, false, 5)).toEqual({ banner: null, cleared: false });
  });
});
