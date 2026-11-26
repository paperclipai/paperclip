// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, type QueryObserverOptions } from "@tanstack/react-query";
import type { TaskBrowser } from "@paperclipai/shared";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { createCoalescingQueryClient } from "../lib/query-invalidation-batcher";
import { liveRunRefetchInterval } from "../lib/live-runs-cache";
import { taskBrowsersQueryKey, taskBrowsersRefetchInterval } from "../hooks/useTaskBrowsers";
import { queryKeys } from "../lib/queryKeys";

const COMPANY = "company-1";
const TASK_UUID = "11111111-1111-4111-8111-111111111111";
const TASK_REF = "DEMO-1";
const ACTOR = { userId: "viewer", agentId: null };
// The staging capture that motivated this test observed one task for 17 seconds.
const WINDOW_MS = 17_000;

type Counter = ReturnType<typeof vi.fn>;

const liveRun = {
  id: "run-open", status: "running", invocationSource: "assignment", triggerDetail: null,
  startedAt: "2026-11-09T00:00:00.000Z", finishedAt: null, createdAt: "2026-11-09T00:00:00.000Z",
  agentId: "agent-1", agentName: "Agent One", adapterType: "claude_local", issueId: TASK_UUID,
};

function observe<T>(client: QueryClient, options: QueryObserverOptions<T, Error, T, T, readonly unknown[]>) {
  const observer = new QueryObserver(client, options);
  return observer.subscribe(() => {});
}

/**
 * Mount the reads an open, running task keeps active: the sidebar's recent-task
 * summaries and agent list, the company run list, the task's child lists, its
 * run list (two observers at the task view's two intervals), and its browsers.
 */
function mountOpenTask(client: QueryClient, connected: boolean) {
  const counters: Record<string, Counter> = {};
  const read = <T,>(name: string, data: T) => {
    counters[name] ??= vi.fn(async () => data);
    return counters[name] as unknown as () => Promise<T>;
  };
  const stale = { staleTime: 30_000 };
  const unsubscribes = [
    observe(client, { queryKey: queryKeys.issues.summaryBatch(COMPANY, "viewer", ["a", "b"]), queryFn: read("summaries", []), ...stale }),
    observe(client, { queryKey: queryKeys.agents.list(COMPANY), queryFn: read("agents", []), ...stale }),
    observe(client, { queryKey: queryKeys.liveRuns(COMPANY), queryFn: read("companyLiveRuns", [liveRun]), ...stale }),
    observe(client, { queryKey: queryKeys.issues.listByParent(COMPANY, TASK_UUID), queryFn: read("parentList", []), ...stale }),
    observe(client, { queryKey: queryKeys.issues.listCreatedFromIssue(COMPANY, TASK_UUID), queryFn: read("createdFromList", []), ...stale }),
    observe(client, { queryKey: queryKeys.issues.listByDescendantRoot(COMPANY, TASK_UUID), queryFn: read("descendantList", []), ...stale }),
    ...[1000, 3000].map((fallback) => observe<unknown[]>(client, {
      queryKey: queryKeys.issues.liveRuns(TASK_REF), queryFn: read("taskLiveRuns", [liveRun]), ...stale,
      refetchInterval: (query) => liveRunRefetchInterval(connected, query.state, fallback),
    })),
    observe<TaskBrowser[]>(client, {
      queryKey: taskBrowsersQueryKey(TASK_UUID), queryFn: read("taskBrowsers", [] as TaskBrowser[]), ...stale,
      refetchInterval: (query) => taskBrowsersRefetchInterval(connected, query.state),
    }),
  ];
  return { counters, unmount: () => unsubscribes.forEach((unsubscribe) => unsubscribe()) };
}

/**
 * A busy company: other agents' runs change state about once a second and
 * other tasks log activity a little more often. None of it is about the open task.
 */
function deliverBusyCompanyStream(client: QueryClient) {
  const gate = { cooldownHits: new Map<string, number[]>(), suppressUntil: 0, observedRunOutcomes: new Set<string>() };
  let id = 0;
  const deliver = (type: string, payload: Record<string, unknown>) =>
    __liveUpdatesTestUtils.handleLiveEvent(client, COMPANY, `/DEMO/issues/${TASK_REF}`, {
      id: ++id, companyId: COMPANY, type, createdAt: new Date().toISOString(), payload,
    } as Parameters<typeof __liveUpdatesTestUtils.handleLiveEvent>[3], () => null, gate, ACTOR);
  const timers = [
    setInterval(() => deliver("heartbeat.run.status", {
      runId: `run-other-${id % 4}`, agentId: `agent-${id % 4}`, issueId: `other-${id % 4}`, status: "running",
    }), 1000),
    setInterval(() => deliver("activity.logged", {
      entityType: "issue", entityId: `other-${id % 5}`, action: "issue.comment_added", actorType: "agent", actorId: "agent-2",
    }), 700),
  ];
  return () => timers.forEach((timer) => clearInterval(timer));
}

async function countRequests(connected: boolean, wire: (client: QueryClient) => { client: QueryClient; dispose: () => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const live = wire(client);
  const task = mountOpenTask(client, connected);
  await vi.advanceTimersByTimeAsync(0);
  const stop = connected ? deliverBusyCompanyStream(live.client) : () => {};
  await vi.advanceTimersByTimeAsync(WINDOW_MS);
  stop();
  task.unmount();
  live.dispose();
  client.clear();
  return Object.fromEntries(Object.entries(task.counters).map(([name, fn]) => [name, fn.mock.calls.length]));
}

const liveWiring = (client: QueryClient) => {
  const batcher = __liveUpdatesTestUtils.createLiveInvalidationBatcher(client, COMPANY);
  return { client: createCoalescingQueryClient(client, batcher), dispose: batcher.dispose };
};

describe("open-task request fan-out", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("bounds company-wide refetches and connected run and browser polling during a busy 17-second visit", async () => {
    const counts = await countRequests(true, liveWiring);
    // Printed for the before/after comparison in the pull request.
    console.info("open-task fan-out (connected, busy company)", JSON.stringify(counts));
    // Ambient lists: the first mount plus at most one refresh per spacing window.
    for (const name of ["summaries", "agents", "parentList", "createdFromList", "descendantList"]) {
      expect(counts[name], name).toBeLessThanOrEqual(1 + Math.ceil(WINDOW_MS / 5_000));
      expect(counts[name], name).toBeGreaterThan(1);
    }
    // The task's run list waits for its own lifecycle events plus a slow safety read.
    expect(counts.taskLiveRuns).toBeLessThanOrEqual(1 + Math.floor(WINDOW_MS / 15_000));
    // No browsers and an open connection: one read; browser activity refreshes it.
    expect(counts.taskBrowsers).toBe(1);
  });

  it("keeps the polling fallback while the live connection is closed", async () => {
    const counts = await countRequests(false, (client) => ({ client, dispose: () => {} }));
    expect(counts.taskLiveRuns).toBeGreaterThanOrEqual(WINDOW_MS / 1000);
    expect(counts.taskBrowsers).toBeGreaterThanOrEqual(WINDOW_MS / 3000);
  });

  it("refreshes ambient lists after one normal batch when the company is quiet", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const live = liveWiring(client);
    const task = mountOpenTask(client, true);
    await vi.advanceTimersByTimeAsync(0);
    __liveUpdatesTestUtils.invalidateActivityQueries(live.client, COMPANY,
      { entityType: "issue", entityId: "other-1", action: "issue.updated", actorType: "agent", actorId: "agent-2" }, ACTOR);
    await vi.advanceTimersByTimeAsync(400);
    expect(task.counters.summaries).toHaveBeenCalledTimes(2);
    expect(task.counters.descendantList).toHaveBeenCalledTimes(2);
    task.unmount();
    live.dispose();
    client.clear();
  });
});

describe("task browser refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes the open task's browsers on its browser activity only", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const live = liveWiring(client);
    const task = mountOpenTask(client, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task.counters.taskBrowsers).toHaveBeenCalledTimes(1);
    const activity = (entityId: string, action: string) => __liveUpdatesTestUtils.invalidateActivityQueries(live.client, COMPANY,
      { entityType: "issue", entityId, action, actorType: "system", actorId: "browser-use-cloud" }, ACTOR);
    activity(TASK_UUID, "browser.started");
    await vi.advanceTimersByTimeAsync(400);
    expect(task.counters.taskBrowsers).toHaveBeenCalledTimes(2);
    activity("other-1", "browser.started");
    activity(TASK_UUID, "issue.comment_added");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task.counters.taskBrowsers).toHaveBeenCalledTimes(2);
    task.unmount();
    live.dispose();
    client.clear();
  });
});

describe("ambient invalidation lane", () => {
  const { isAmbientCompanyQueryKey } = __liveUpdatesTestUtils;

  it.each([
    queryKeys.issues.list(COMPANY),
    queryKeys.issues.summaryBatch(COMPANY, "viewer", ["a"]),
    queryKeys.issues.listByDescendantRoot(COMPANY, TASK_UUID),
    queryKeys.agents.list(COMPANY),
    queryKeys.liveRuns(COMPANY),
    queryKeys.heartbeats(COMPANY),
    queryKeys.sidebarBadges(COMPANY),
    queryKeys.dashboard(COMPANY),
    queryKeys.activity(COMPANY),
  ].map((key) => [key]))("spaces the company-wide key %j", (queryKey) => {
    expect(isAmbientCompanyQueryKey(COMPANY, queryKey)).toBe(true);
  });

  it.each([
    queryKeys.issues.detail(TASK_REF),
    queryKeys.issues.comments(TASK_UUID),
    queryKeys.issues.liveRuns(TASK_REF),
    queryKeys.issues.activeRun(TASK_UUID),
    queryKeys.agents.detail("agent-1"),
    taskBrowsersQueryKey(TASK_UUID),
    queryKeys.attention(COMPANY),
    queryKeys.issues.list("company-2"),
  ].map((key) => [key]))("keeps %j on the fast lane", (queryKey) => {
    expect(isAmbientCompanyQueryKey(COMPANY, queryKey)).toBe(false);
  });

  it("uses no ambient lane without a live company", () => {
    expect(isAmbientCompanyQueryKey(null, queryKeys.issues.list(COMPANY))).toBe(false);
  });
});
