// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

const COMPANY = "company-1";
const ACTOR = { userId: "user-1", agentId: null };

function mountQuery(client: QueryClient, queryKey: readonly unknown[]) {
  const queryFn = vi.fn(async () => [] as unknown[]);
  const observer = new QueryObserver(client, { queryKey, queryFn, staleTime: 60_000 });
  const unsubscribe = observer.subscribe(() => {});
  return { queryFn, unsubscribe };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function emit(client: QueryClient, payload: Record<string, unknown>) {
  __liveUpdatesTestUtils.invalidateActivityQueries(client, COMPANY, { entityType: "issue", ...payload }, ACTOR);
}

describe("LiveUpdatesProvider @task mention pool", () => {
  let client: QueryClient;
  afterEach(() => client?.clear());

  it("does not refetch the mention pool for a burst of comment, run and status events", async () => {
    client = new QueryClient();
    const pool = mountQuery(client, queryKeys.issues.mentionPool(COMPANY));
    const otherList = mountQuery(client, [...queryKeys.issues.list(COMPANY), "descendants", "task-1"]);
    await settle();
    expect(pool.queryFn).toHaveBeenCalledTimes(1);
    expect(otherList.queryFn).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 25; i += 1) {
      emit(client, { entityId: "task-1", action: "issue.comment_added", details: { commentId: `c-${i}` } });
      emit(client, { entityId: "task-2", action: "issue.updated", details: { status: "in_progress", source: "comment" } });
      emit(client, { entityId: "task-3", action: "issue.checked_out", details: {} });
      await settle();
    }

    expect(pool.queryFn).toHaveBeenCalledTimes(1);
    // Marked stale, so the next mount or focus still picks up the new order.
    expect(client.getQueryState(queryKeys.issues.mentionPool(COMPANY))?.isInvalidated).toBe(true);
    // Other company-scoped issue queries keep their existing live refresh.
    expect(otherList.queryFn.mock.calls.length).toBeGreaterThan(1);
    pool.unsubscribe();
    otherList.unsubscribe();
  });

  it.each([
    ["a created task", { entityId: "task-9", action: "issue.created", details: { identifier: "REF-9" } }],
    ["a deleted task", { entityId: "task-9", action: "issue.deleted", details: {} }],
    ["a renamed task", { entityId: "task-9", action: "issue.updated", details: { title: "Renamed", identifier: "REF-9" } }],
    ["a renamed task reported as a change", { entityId: "task-9", action: "issue.updated", details: { changes: { title: { from: "a", to: "b" } } } }],
  ])("refetches the mention pool immediately for %s", async (_label, payload) => {
    client = new QueryClient();
    const pool = mountQuery(client, queryKeys.issues.mentionPool(COMPANY));
    await settle();
    expect(pool.queryFn).toHaveBeenCalledTimes(1);

    emit(client, payload);
    await settle();

    expect(pool.queryFn).toHaveBeenCalledTimes(2);
    pool.unsubscribe();
  });
});
