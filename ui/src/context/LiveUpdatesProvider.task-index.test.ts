// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { createCoalescingQueryClient } from "../lib/query-invalidation-batcher";
import { queryKeys } from "../lib/queryKeys";

const COMPANY = "company-1";
const ACTOR = { userId: "user-1", agentId: null };
const INDEX_KEY = queryKeys.issues.listIndex(COMPANY);
const WINDOW_MS = __liveUpdatesTestUtils.TASK_INDEX_REFRESH_WINDOW_MS;

function task(id: string, patch: Partial<Issue> = {}): Issue {
  return { id, identifier: id.toUpperCase(), title: `Task ${id}`, status: "todo", ...patch } as Issue;
}

function serverList(initial: Issue[]) {
  let rows = initial;
  const queryFn = vi.fn(async () => rows);
  return { queryFn, set: (next: Issue[]) => { rows = next; } };
}

function mount(client: QueryClient, queryKey: readonly unknown[], queryFn: () => Promise<unknown>) {
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: 60_000 });
  return observer.subscribe(() => {});
}

function emit(client: QueryClient, payload: Record<string, unknown>) {
  __liveUpdatesTestUtils.invalidateActivityQueries(client, COMPANY, { entityType: "issue", actorType: "agent", actorId: "agent-1", ...payload }, ACTOR);
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("LiveUpdatesProvider company task index", () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("refetches the index at most once per window during a burst of task activity", async () => {
    const index = serverList([task("t1")]);
    const other = serverList([]);
    const unmountIndex = mount(client, INDEX_KEY, index.queryFn);
    const unmountOther = mount(client, [...queryKeys.issues.list(COMPANY), "descendants", "t1"], other.queryFn);
    await settle(WINDOW_MS);
    expect(index.queryFn).toHaveBeenCalledTimes(1);

    for (let second = 0; second < 60; second += 1) {
      emit(client, { entityId: "t1", action: "issue.comment_added" });
      emit(client, { entityId: "t1", action: "issue.updated", details: { status: "in_progress" } });
      await settle(1_000);
    }
    await settle(WINDOW_MS);

    expect(index.queryFn).toHaveBeenCalledTimes(4);
    expect(other.queryFn.mock.calls.length).toBeGreaterThan(60);
    unmountIndex();
    unmountOther();
  });

  it("refetches at once for the first event after a quiet window", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle(WINDOW_MS);
    emit(client, { entityId: "t1", action: "issue.updated", details: { title: "Renamed" } });
    await settle();
    expect(index.queryFn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it.each([
    ["a created task", { entityId: "t3", action: "issue.created", details: { identifier: "T3" } }, [task("t1"), task("t2"), task("t3")]],
    ["a deleted task", { entityId: "t2", action: "issue.deleted", details: {} }, [task("t1")]],
    ["a hidden task", { entityId: "t2", action: "issue.updated", details: { hiddenAt: "2026-11-13T00:00:00.000Z" } }, [task("t1")]],
    ["a status, title and priority change", { entityId: "t1", action: "issue.updated", details: { status: "done" } },
      [task("t1", { status: "done", title: "Renamed", priority: "high" }), task("t2")]],
    ["an event for a task outside the cache", { entityId: "t9", action: "issue.comment_added" }, [task("t1"), task("t2")]],
    ["an event for a task the viewer cannot read", { entityId: "private-1", action: "issue.updated", details: { title: "Secret" } }, [task("t1"), task("t2")]],
  ])("shows the server's list after %s, inside one window, with nothing taken from the event", async (_name, event, next) => {
    const initial = [task("t1"), task("t2")];
    const index = serverList(initial);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle();
    emit(client, { entityId: "t1", action: "issue.comment_added" });
    await settle(1_000);
    index.set(next);
    emit(client, event);
    await settle();
    expect(client.getQueryData(INDEX_KEY)).toEqual(initial);
    await settle(WINDOW_MS);
    expect(client.getQueryData(INDEX_KEY)).toEqual(next);
    expect(JSON.stringify(client.getQueryData(INDEX_KEY))).not.toContain("Secret");
    unmount();
  });

  it("refreshes at once for the viewer's own task activity, even inside a window", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle();
    emit(client, { entityId: "t1", action: "issue.comment_added" });
    await settle(1_000);
    index.set([task("t1"), task("t2")]);
    __liveUpdatesTestUtils.invalidateActivityQueries(client, COMPANY,
      { entityType: "issue", entityId: "t2", action: "issue.created", actorType: "user", actorId: "user-1", details: { identifier: "T2" } }, ACTOR);
    await settle();
    expect(client.getQueryData(INDEX_KEY)).toEqual([task("t1"), task("t2")]);
    unmount();
  });

  it("refreshes at once when this tab changes a task and invalidates the company task lists", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle();
    emit(client, { entityId: "t1", action: "issue.comment_added" });
    await settle(1_000);
    index.set([task("t1", { status: "done" })]);
    await client.invalidateQueries({ queryKey: queryKeys.issues.list(COMPANY) });
    await settle();
    expect(client.getQueryData(INDEX_KEY)).toEqual([task("t1", { status: "done" })]);
    unmount();
  });

  it("never loses an event inside the window: the last state shows when the window ends after activity stops", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle(WINDOW_MS);
    for (let second = 0; second < 10; second += 1) {
      index.set([task("t1", { title: `Edit ${second}` })]);
      emit(client, { entityId: "t1", action: "issue.updated", details: { title: `Edit ${second}` } });
      await settle(1_000);
    }
    expect(client.getQueryData(INDEX_KEY)).not.toEqual([task("t1", { title: "Edit 9" })]);
    await settle(WINDOW_MS);
    expect(client.getQueryData(INDEX_KEY)).toEqual([task("t1", { title: "Edit 9" })]);
    unmount();
  });

  it("marks an unwatched index stale without fetching, and a later mount refetches it", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle();
    unmount();
    emit(client, { entityId: "t1", action: "issue.updated", details: { status: "done" } });
    await settle(WINDOW_MS);
    expect(index.queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(INDEX_KEY)?.isInvalidated).toBe(true);
    const remount = mount(client, INDEX_KEY, index.queryFn);
    await settle();
    expect(index.queryFn).toHaveBeenCalledTimes(2);
    remount();
  });

  it("keeps the window when events arrive through the live-event batcher", async () => {
    const index = serverList([task("t1")]);
    const unmount = mount(client, INDEX_KEY, index.queryFn);
    await settle(WINDOW_MS);
    const batched = createCoalescingQueryClient(client, __liveUpdatesTestUtils.createLiveInvalidationBatcher(client, COMPANY));
    for (let second = 0; second < 20; second += 1) {
      __liveUpdatesTestUtils.invalidateActivityQueries(batched, COMPANY,
        { entityType: "issue", entityId: "t1", action: "issue.comment_added", actorType: "agent", actorId: "agent-1" }, ACTOR);
      await settle(1_000);
    }
    await settle(WINDOW_MS);
    expect(index.queryFn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(index.queryFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    unmount();
  });
});
