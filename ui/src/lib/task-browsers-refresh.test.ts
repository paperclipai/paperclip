// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { TaskBrowser } from "@paperclipai/shared";
import { taskBrowsersRefetchInterval } from "../hooks/useTaskBrowsers";
import { refreshTaskBrowsers, taskBrowsersQueryKey } from "./task-browsers-refresh";

const TASK = "12345678-1234-4234-8234-123456789abc";
const started: TaskBrowser = {
  id: "browser-1", sessionId: "session-1", issueId: TASK, status: "running", runStatus: "running",
  progress: null, costCents: 0, idleDeadline: null, expiresAt: null, error: null, createdAt: "2026-11-09T10:00:00Z",
};
let client: QueryClient;

/** One mounted `useTaskBrowsers` with the live connection open. */
function observe(list: () => Promise<TaskBrowser[]>) {
  const observer = new QueryObserver<TaskBrowser[]>(client, {
    queryKey: taskBrowsersQueryKey(TASK), queryFn: list, staleTime: 30_000,
    refetchInterval: (query) => taskBrowsersRefetchInterval(true, query.state),
  });
  return { observer, unsubscribe: observer.subscribe(() => {}) };
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

it("reads again after a delayed empty read when the browser starts during that read", async () => {
  let release!: (value: TaskBrowser[]) => void;
  const list = vi.fn<() => Promise<TaskBrowser[]>>()
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue([started]);
  const view = observe(list);
  await vi.advanceTimersByTimeAsync(1);
  refreshTaskBrowsers(client, TASK);
  await vi.advanceTimersByTimeAsync(1);
  // The refresh waits for the older read instead of joining it.
  expect(list).toHaveBeenCalledTimes(1);
  release([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.observer.getCurrentResult().data).toEqual([started]);
  view.unsubscribe();
});

it("queues one follow-up for two views and repeated events during one read", async () => {
  let release!: (value: TaskBrowser[]) => void;
  const list = vi.fn<() => Promise<TaskBrowser[]>>()
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValue([]);
  const page = observe(list);
  const panel = observe(list);
  await vi.advanceTimersByTimeAsync(1);
  refreshTaskBrowsers(client, TASK);
  refreshTaskBrowsers(client, TASK);
  release([]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list).toHaveBeenCalledTimes(2);
  page.unsubscribe();
  panel.unsubscribe();
});

it("refreshes an idle list at once and stops polling when it stays empty", async () => {
  const list = vi.fn(async () => [] as TaskBrowser[]);
  const view = observe(list);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list).toHaveBeenCalledTimes(1);
  refreshTaskBrowsers(client, TASK);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list).toHaveBeenCalledTimes(2);
  view.unsubscribe();
});

it("makes a returning view read a list cached while the task was closed", async () => {
  const list = vi.fn<() => Promise<TaskBrowser[]>>().mockResolvedValueOnce([]).mockResolvedValue([started]);
  const first = observe(list);
  await vi.advanceTimersByTimeAsync(1);
  first.unsubscribe();
  refreshTaskBrowsers(client, TASK);
  await vi.advanceTimersByTimeAsync(1);
  // Nothing observes the list, so the refresh only marks it stale.
  expect(list).toHaveBeenCalledTimes(1);
  const returning = observe(list);
  await vi.advanceTimersByTimeAsync(1);
  expect(list).toHaveBeenCalledTimes(2);
  expect(returning.observer.getCurrentResult().data).toEqual([started]);
  returning.unsubscribe();
});

it("does nothing for a task without a cached browser list", () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  refreshTaskBrowsers(client, TASK);
  expect(invalidate).not.toHaveBeenCalled();
});
