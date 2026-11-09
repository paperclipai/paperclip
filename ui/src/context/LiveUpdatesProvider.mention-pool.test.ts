// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { createCoalescingQueryClient, createInvalidationBatcher } from "../lib/query-invalidation-batcher";
import { queryKeys } from "../lib/queryKeys";

const COMPANY = "company-1";
const ACTOR = { userId: "user-1", agentId: null };
const POOL_KEY = queryKeys.issues.mentionPool(COMPANY);
const WINDOW_MS = __liveUpdatesTestUtils.MENTION_POOL_REFRESH_WINDOW_MS;

function task(id: string): Issue {
  return { id, identifier: id.toUpperCase(), title: `Task ${id}` } as Issue;
}

function mountQuery(client: QueryClient, queryKey: readonly unknown[], data: unknown[] = []) {
  const queryFn = vi.fn(async () => data);
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: 60_000 });
  const unsubscribe = observer.subscribe(() => {});
  return { queryFn, unsubscribe };
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Authenticated sockets carry no `details`, only the closed identity flag. */
function authenticatedEvent(entityId: string, action: string, taskIdentityChanged: boolean) {
  return { entityType: "issue", entityId, action, actorType: "agent", actorId: "agent-1", taskIdentityChanged };
}

function emit(client: QueryClient, payload: Record<string, unknown>) {
  __liveUpdatesTestUtils.invalidateActivityQueries(client, COMPANY, { entityType: "issue", ...payload }, ACTOR);
}

const POOL = [task("t1"), task("t2"), task("t3")];

describe("LiveUpdatesProvider @task mention pool", () => {
  let client: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    client = new QueryClient();
  });
  afterEach(() => {
    client.clear();
    vi.useRealTimers();
  });

  it("does not refetch for a burst of authenticated progress events on pooled tasks, and reorders in place", async () => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    const otherList = mountQuery(client, [...queryKeys.issues.list(COMPANY), "descendants", "t1"]);
    await settle();
    expect(pool.queryFn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 25; i += 1) {
      emit(client, authenticatedEvent("t3", "issue.comment_added", false));
      emit(client, authenticatedEvent("t3", "issue.updated", false));
      emit(client, authenticatedEvent("t2", "issue.checked_out", false));
      await settle();
    }
    await settle(WINDOW_MS * 2);

    expect(pool.queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<Issue[]>(POOL_KEY)?.map((issue) => issue.id)).toEqual(["t2", "t3", "t1"]);
    // Other company-scoped issue queries keep their live refresh.
    expect(otherList.queryFn.mock.calls.length).toBeGreaterThan(1);
    pool.unsubscribe();
    otherList.unsubscribe();
  });

  it.each([
    ["an authenticated identity change", authenticatedEvent("t9", "issue.updated", true)],
    ["a created task", { entityId: "t9", action: "issue.created", details: { identifier: "T9" } }],
    ["a deleted task", { entityId: "t1", action: "issue.deleted", details: {} }],
    ["a renamed task", { entityId: "t1", action: "issue.updated", details: { title: "Renamed" } }],
    ["a hidden task", { entityId: "t1", action: "issue.updated", details: { hiddenAt: "2026-11-07T00:00:00.000Z" } }],
    ["an unhidden task", { entityId: "t1", action: "issue.updated", details: { hiddenAt: null } }],
  ])("refetches immediately for %s", async (_label, payload) => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    await settle();
    emit(client, payload);
    await settle();
    expect(pool.queryFn).toHaveBeenCalledTimes(2);
    pool.unsubscribe();
  });

  it("refetches at most once per window when events touch tasks outside the pool", async () => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    await settle();

    for (let i = 0; i < 20; i += 1) {
      emit(client, authenticatedEvent(`outside-${i}`, "issue.comment_added", false));
      await settle(100);
    }
    expect(pool.queryFn).toHaveBeenCalledTimes(1);

    // The trailing refresh lands one window after the last fetch.
    await settle(WINDOW_MS);
    expect(pool.queryFn).toHaveBeenCalledTimes(2);

    // Quiet afterwards: no further refetch without new events.
    await settle(WINDOW_MS * 2);
    expect(pool.queryFn).toHaveBeenCalledTimes(2);
    pool.unsubscribe();
  });

  it("only marks an unmounted pool stale", async () => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    await settle();
    pool.unsubscribe();
    emit(client, authenticatedEvent("outside", "issue.updated", false));
    await settle(WINDOW_MS * 2);
    expect(pool.queryFn).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(POOL_KEY)?.isInvalidated).toBe(true);
  });

  it("keeps a pending refresh when a later event reorders a closed picker's pool", async () => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    await settle();
    pool.unsubscribe();
    const fetchedAt = client.getQueryState(POOL_KEY)?.dataUpdatedAt;
    // A rename while the picker is closed marks the pool stale without a fetch.
    emit(client, { entityId: "t1", action: "issue.updated", details: { title: "Renamed" } });
    emit(client, authenticatedEvent("t3", "issue.comment_added", false));
    await settle();
    const state = client.getQueryState(POOL_KEY);
    expect(state?.isInvalidated).toBe(true);
    expect(state?.dataUpdatedAt).toBe(fetchedAt);

    // Reopening the picker within staleTime still fetches the renamed list.
    const reopened = mountQuery(client, POOL_KEY, POOL);
    await settle();
    expect(reopened.queryFn).toHaveBeenCalledTimes(1);
    reopened.unsubscribe();
  });

  it("does not reset the freshness clock when it reorders in place", async () => {
    const pool = mountQuery(client, POOL_KEY, POOL);
    await settle();
    const fetchedAt = client.getQueryState(POOL_KEY)?.dataUpdatedAt;
    await settle(5_000);
    emit(client, authenticatedEvent("t3", "issue.comment_added", false));
    await settle();
    expect(client.getQueryData<Issue[]>(POOL_KEY)?.[0]?.id).toBe("t3");
    expect(client.getQueryState(POOL_KEY)?.dataUpdatedAt).toBe(fetchedAt);
    pool.unsubscribe();
  });

  it("coalesces a burst through the live-event batcher into one broad refresh", async () => {
    const batcher = createInvalidationBatcher(client);
    const coalescing = createCoalescingQueryClient(client, batcher);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const pool = mountQuery(client, POOL_KEY, POOL);
    const otherList = mountQuery(client, [...queryKeys.issues.list(COMPANY), "descendants", "t1"]);
    await settle();

    for (let i = 0; i < 30; i += 1) {
      __liveUpdatesTestUtils.invalidateActivityQueries(coalescing, COMPANY, authenticatedEvent("t1", "issue.comment_added", false), ACTOR);
    }
    await settle(1_000);

    const broad = invalidate.mock.calls.filter(([filters]) =>
      JSON.stringify(filters?.queryKey) === JSON.stringify(queryKeys.issues.list(COMPANY)));
    expect(broad).toHaveLength(1);
    expect(otherList.queryFn).toHaveBeenCalledTimes(2);
    expect(pool.queryFn).toHaveBeenCalledTimes(1);
    batcher.dispose();
    pool.unsubscribe();
    otherList.unsubscribe();
  });
});
