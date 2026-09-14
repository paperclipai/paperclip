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

const { getIssue } = vi.hoisted(() => ({ getIssue: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: getIssue } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const task = (updatedAt: number, title: string, status: "todo" | "done" = "todo") => ({
  id: "issue-1", companyId: "company-1", identifier: "TASK-1", title, status,
  updatedAt: new Date(updatedAt), hiddenAt: null,
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

  function RecentTasks({ name }: { name: string }) {
    const { entries } = useRecentTasks({ companyId: "company-1", userId: "user-1" });
    renders += 1;
    // Fail promptly if a regression restores the cross-cache render loop.
    if (renders > 100) throw new Error("Recent Tasks did not settle");
    return <div data-tab={name}>{entries.map((entry) => `${entry.title}:${entry.status}`).join(",")}</div>;
  }

  function client(snapshot?: ReturnType<typeof task>) {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    if (snapshot) value.setQueryData(queryKeys.issues.detail(snapshot.id), snapshot);
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

  it.each([403, 404])("still removes tasks whose query returns %s", async (status) => {
    recordRecentTask(task(10, "Unavailable"), "user-1");
    getIssue.mockRejectedValue(new ApiError("Unavailable", status, null));
    await act(async () => root.render(
      <QueryClientProvider client={client()}><RecentTasks name="unavailable" /></QueryClientProvider>,
    ));
    await flush();
    expect(readRecentTasks(storageKey, "company-1")).toEqual([]);
    expect(container.textContent).toBe("");
    expect(getIssue).toHaveBeenCalledTimes(1);
  });
});
