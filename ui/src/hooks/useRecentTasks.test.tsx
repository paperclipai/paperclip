// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import {
  getRecentTasksStorageKey,
  readRecentTasks,
  recordRecentTask,
  RECENT_TASKS_UPDATED_EVENT,
} from "@/lib/recent-tasks";
import { useRecentTasks } from "./useRecentTasks";

const { getIssue, summaries } = vi.hoisted(() => ({ getIssue: vi.fn(), summaries: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: getIssue, summaries } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const task = (updatedAt: number, title: string, status: "todo" | "done" = "todo") => ({
  id: "issue-1", companyId: "company-1", identifier: "TASK-1", title, status,
  updatedAt: new Date(updatedAt), hiddenAt: null, projectId: null,
});
const storageKey = getRecentTasksStorageKey("company-1", "user-1");
// Node 24 uses jsdom Storage; newer Node versions use the setup's storage shim.
// jsdom's Storage proxy does not support spying on instance methods.
const storageMethods = window.localStorage instanceof window.Storage ? window.Storage.prototype : window.localStorage;

describe("recent task synchronization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let clients: QueryClient[];
  let renders: number;

  function RecentTasks({ name, companyId = "company-1", userId = "user-1" }: { name: string; companyId?: string; userId?: string }) {
    const { entries } = useRecentTasks({ companyId, userId });
    renders += 1;
    // Fail promptly if a regression restores the cross-cache render loop.
    if (renders > 100) throw new Error("Recent Tasks did not settle");
    return <div data-tab={name}>{entries.map((entry) => `${entry.title}:${entry.status}`).join(",")}</div>;
  }

  function client(snapshot?: ReturnType<typeof task>) {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (snapshot) {
      value.setQueryData(queryKeys.issues.detail(snapshot.id), snapshot);
      value.setQueryData(queryKeys.issues.summaryBatch("company-1", "user-1", [snapshot.id]), [snapshot]);
    }
    clients.push(value);
    return value;
  }

  async function flush() {
    await act(async () => {
      for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    localStorage.clear();
    getIssue.mockReset();
    summaries.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    clients = [];
    renders = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    clients.forEach((value) => value.clear());
    container.remove();
    vi.restoreAllMocks();
  });

  it("settles independent stale and fresh query caches and displays the newer snapshot in both", async () => {
    const older = task(10, "Old title");
    const newer = task(20, "New title", "done");
    recordRecentTask(older, "user-1");
    const staleClient = client(older);
    const freshClient = client(newer);
    const setItem = vi.spyOn(storageMethods, "setItem");
    await act(async () => root.render(<>
      <QueryClientProvider client={staleClient}><RecentTasks name="stale" /></QueryClientProvider>
      <QueryClientProvider client={freshClient}><RecentTasks name="fresh" /></QueryClientProvider>
    </>));
    await flush();
    expect(container.querySelector('[data-tab="stale"]')?.textContent).toBe("New title:done");
    expect(container.querySelector('[data-tab="fresh"]')?.textContent).toBe("New title:done");
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(getIssue).not.toHaveBeenCalled();
    const settledRenders = renders;
    await flush();
    expect(renders).toBe(settledRenders);

    // A real query update still propagates after the two caches settle.
    await act(async () => {
      freshClient.setQueryData(queryKeys.issues.detail(newer.id), task(30, "Renamed", "done"));
    });
    await flush();
    expect(container.querySelector('[data-tab="stale"]')?.textContent).toBe("Renamed:done");
    expect(readRecentTasks(storageKey, "company-1")[0]?.snapshotUpdatedAt).toBe(30);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it("receives storage updates without republishing cached data", async () => {
    const cached = task(20, "Cached", "done");
    recordRecentTask(cached, "user-1");
    await act(async () => root.render(
      <QueryClientProvider client={client(cached)}><RecentTasks name="receiver" /></QueryClientProvider>,
    ));
    await flush();
    // Simulate a concurrent write from another tab with an older snapshot.
    const incoming = { ...readRecentTasks(storageKey, "company-1")[0], title: "Older", snapshotUpdatedAt: 10 };
    localStorage.setItem(storageKey, JSON.stringify([incoming]));
    const setItem = vi.spyOn(storageMethods, "setItem");
    const publish = vi.fn();
    window.addEventListener(RECENT_TASKS_UPDATED_EVENT, publish);
    try {
      await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: storageKey })); });
      await flush();
      expect(container.textContent).toBe("Cached:done");
      expect(setItem).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(RECENT_TASKS_UPDATED_EVENT, publish);
    }
  });

  it("ignores writes from the old application after migration", async () => {
    const legacyKey = "paperclip.recentTasks:company-1:user-1";
    localStorage.setItem(legacyKey, JSON.stringify([{ ...task(10, "Legacy"), recordedAt: 100 }]));
    await act(async () => root.render(
      <QueryClientProvider client={client(task(20, "Current", "done"))}><RecentTasks name="current" /></QueryClientProvider>,
    ));
    await flush();
    expect(container.textContent).toBe("Current:done");
    const settledRenders = renders;
    await act(async () => {
      localStorage.setItem(legacyKey, "[]");
      window.dispatchEvent(new StorageEvent("storage", { key: legacyKey }));
      window.dispatchEvent(new CustomEvent(RECENT_TASKS_UPDATED_EVENT, { detail: { storageKey: legacyKey, entries: [] } }));
    });
    await flush();
    expect(renders).toBe(settledRenders);
    expect(container.textContent).toBe("Current:done");
    expect(readRecentTasks(storageKey, "company-1")[0]?.recordedAt).toBe(100);
  });

  it.each([403, 500])("retains snapshots when the batch fails with %s", async (status) => {
    recordRecentTask(task(10, "Unavailable"), "user-1");
    summaries.mockRejectedValue(new ApiError("Unavailable", status, null));
    await act(async () => root.render(
      <QueryClientProvider client={client()}><RecentTasks name="unavailable" /></QueryClientProvider>,
    ));
    await flush();
    expect(readRecentTasks(storageKey, "company-1")).toHaveLength(1);
    expect(container.textContent).toBe("Unavailable:todo");
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("fetches five tasks once without activating detail queries", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ ...task(i + 1, `Task ${i}`), id: `issue-${i}` }));
    tasks.forEach(issue => recordRecentTask(issue, "user-1"));
    summaries.mockResolvedValue(tasks);
    const cache = client();
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="batch" /></QueryClientProvider>));
    await flush();
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(summaries.mock.calls[0][1]).toEqual(tasks.map(issue => issue.id).sort());
    expect(getIssue).not.toHaveBeenCalled();
    expect(cache.getQueryCache().findAll({ queryKey: ["issues", "detail"] })).toEqual([]);
  });

  it("does not fetch empty history", async () => {
    await act(async () => root.render(<QueryClientProvider client={client()}><RecentTasks name="empty" /></QueryClientProvider>));
    await flush();
    expect(summaries).not.toHaveBeenCalled();
  });

  it("prunes successful omissions without resurrecting cached full details", async () => {
    const missing = task(10, "Removed");
    recordRecentTask(missing, "user-1");
    const cache = client();
    cache.setQueryData(queryKeys.issues.detail(missing.id), task(30, "Cached secret"));
    summaries.mockResolvedValue([]);
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="missing" /></QueryClientProvider>));
    await flush();
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
    expect(container.textContent).toBe("");
  });

  it("does not prune a task added while an older batch is pending", async () => {
    recordRecentTask(task(10, "Missing old task"), "user-1");
    let resolveFirst!: (rows: unknown[]) => void;
    summaries.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<QueryClientProvider client={client()}><RecentTasks name="race" /></QueryClientProvider>));
    const added = { ...task(20, "New task"), id: "issue-2" };
    await act(async () => { recordRecentTask(added, "user-1"); });
    await act(async () => { resolveFirst([]); });
    await flush();
    expect(readRecentTasks(storageKey, "company-1").some(entry => entry.id === added.id)).toBe(true);
    expect(container.textContent).toContain("New task");
  });

  it("isolates an account switch while the old request is pending", async () => {
    recordRecentTask(task(10, "Old account task"), "user-1");
    recordRecentTask({ ...task(20, "New account task"), id: "issue-2" }, "user-2");
    let resolveOld!: (rows: unknown[]) => void;
    summaries.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue([{ ...task(20, "New account task"), id: "issue-2" }]);
    const cache = client();
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="account" /></QueryClientProvider>));
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="account" userId="user-2" /></QueryClientProvider>));
    await act(async () => { resolveOld([task(30, "Old response")]); });
    await flush();
    expect(container.textContent).toBe("New account task:todo");
    expect(readRecentTasks(getRecentTasksStorageKey("company-1", "user-2"), "company-1")[0]?.id).toBe("issue-2");
    expect(summaries.mock.calls.map(call => call[1])).toEqual([["issue-1"], ["issue-2"]]);
  });

  it("refreshes a cached omission when the user revisits an accessible task", async () => {
    const first = task(10, "First");
    const second = { ...task(20, "Second"), id: "issue-2" };
    recordRecentTask(first, "user-1");
    recordRecentTask(second, "user-1");
    summaries.mockResolvedValue([second]);
    const cache = client();
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="revisited" /></QueryClientProvider>));
    await flush();
    expect(readRecentTasks(storageKey, "company-1").map(entry => entry.id)).toEqual([second.id]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(cache.getQueryState(queryKeys.issues.summaryBatch("company-1", "user-1", [second.id]))?.status).toBe("success");
    summaries.mockResolvedValue([first, second]);
    await act(async () => { recordRecentTask(first, "user-1", 30); });
    await flush();
    expect(readRecentTasks(storageKey, "company-1").map(entry => entry.id).sort()).toEqual([first.id, second.id]);
    expect(summaries.mock.calls.filter(call => call[1].length === 2)).toHaveLength(2);
  });

  it("keeps a revisited task when refreshing its cached omission fails", async () => {
    const first = task(10, "First");
    const second = { ...task(20, "Second"), id: "issue-2" };
    recordRecentTask(first, "user-1");
    recordRecentTask(second, "user-1");
    summaries.mockResolvedValue([second]);
    const cache = client();
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="retry-failed" /></QueryClientProvider>));
    await flush();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    summaries.mockRejectedValue(new ApiError("Unavailable", 500, null));
    await act(async () => { recordRecentTask(first, "user-1", 30); });
    await flush();
    expect(readRecentTasks(storageKey, "company-1").map(entry => entry.id).sort()).toEqual([first.id, second.id]);
    expect(cache.getQueryState(queryKeys.issues.summaryBatch("company-1", "user-1", [first.id, second.id]))?.status).toBe("error");
    expect(summaries.mock.calls.filter(call => call[1].length === 2)).toHaveLength(2);
  });

  it("prunes a revisited task when a fresh response repeats the cached omission", async () => {
    const first = task(10, "First");
    const second = { ...task(20, "Second"), id: "issue-2" };
    recordRecentTask(first, "user-1");
    recordRecentTask(second, "user-1");
    const rows = [second];
    summaries.mockResolvedValue(rows);
    const cache = client();
    await act(async () => root.render(<QueryClientProvider client={cache}><RecentTasks name="still-missing" /></QueryClientProvider>));
    await flush();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    await act(async () => { recordRecentTask(first, "user-1", 30); });
    await flush();
    expect(summaries.mock.calls.filter(call => call[1].length === 2)).toHaveLength(2);
    expect(readRecentTasks(storageKey, "company-1").map(entry => entry.id)).toEqual([second.id]);
  });
});
