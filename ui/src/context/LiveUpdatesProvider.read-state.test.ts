import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";

const { invalidateActivityQueries } = __liveUpdatesTestUtils;

function invalidatedKeys(payload: Record<string, unknown>, currentUserId = "viewer") {
  const queryClient = new QueryClient();
  const spy = vi.spyOn(queryClient, "invalidateQueries");
  invalidateActivityQueries(queryClient, "company-1", payload, { userId: currentUserId, agentId: null });
  return spy.mock.calls.map(([filters]) => JSON.stringify((filters as { queryKey?: unknown }).queryKey));
}

const key = (value: unknown) => JSON.stringify(value);

describe("read-state activity invalidation", () => {
  for (const action of ["issue.read_marked", "issue.read_unmarked"]) {
    it(`refreshes only the reader's inbox views for their own ${action}`, () => {
      const keys = invalidatedKeys({ action, entityType: "issue", entityId: "issue-1", actorType: "user", actorId: "viewer" });
      expect(keys).toEqual(expect.arrayContaining([
        key(queryKeys.sidebarBadges("company-1")),
        key(queryKeys.issues.listMineByMe("company-1")),
        key(queryKeys.issues.listTouchedByMe("company-1")),
        key(queryKeys.issues.listUnreadTouchedByMe("company-1")),
      ]));
      expect(keys).not.toContain(key(queryKeys.issues.list("company-1")));
      expect(keys).not.toContain(key(queryKeys.activity("company-1")));
      expect(keys).not.toContain(key(queryKeys.dashboard("company-1")));
    });

    it(`ignores another user's ${action}`, () => {
      expect(invalidatedKeys({ action, entityType: "issue", entityId: "issue-1", actorType: "user", actorId: "someone-else" })).toEqual([]);
    });
  }

  it("still refreshes issue lists for other issue activity", () => {
    const keys = invalidatedKeys({ action: "issue.updated", entityType: "issue", entityId: "issue-1", actorType: "user", actorId: "viewer" });
    expect(keys).toContain(key(queryKeys.issues.list("company-1")));
    expect(keys).toContain(key(queryKeys.activity("company-1")));
  });
});
