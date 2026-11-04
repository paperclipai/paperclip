// @vitest-environment node
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./CompanyContext", () => ({ useCompany: vi.fn() }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn() } }));
import { queryKeys } from "../lib/queryKeys";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";

describe("live read receipts", () => {
  let client: QueryClient;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach(unsubscribe => unsubscribe());
    client.clear();
  });

  function watch(key: QueryKey, next: unknown = "fresh") {
    const collection = key[0] === "agent-chats" || key[0] === "issues" && key[1] !== "detail" && key[1] !== "activity";
    client.setQueryData(key, collection ? [] : "cached");
    const read = vi.fn(async () => next);
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
    subscriptions.push(observer.subscribe(() => undefined));
    return read;
  }

  function receipt(action: string, userId: string, actorId = userId) {
    __liveUpdatesTestUtils.invalidateActivityQueries(client, "company-1", {
      entityType: "issue", entityId: "task-1", action, actorType: "user", actorId,
      details: { userId },
    }, { userId: "viewer", agentId: null });
  }

  it.each(["issue.read_marked", "issue.read_unmarked"])("refreshes the reader's personal views once without fetching task collections for %s", async action => {
    const mine = [...queryKeys.issues.listMineByMe("company-1"), "index", 100];
    const touched = queryKeys.issues.listTouchedByMe("company-1");
    const unread = queryKeys.issues.listUnreadTouchedByMe("company-1");
    const badges = queryKeys.sidebarBadges("company-1");
    const chats = queryKeys.agentChats.list("company-1", "viewer");
    const ownReads = [mine, touched, unread, badges, chats].map(key => watch(key));
    const unrelatedReads = [
      queryKeys.issues.list("company-1"),
      [...queryKeys.issues.list("company-1"), "row-context"],
      queryKeys.issues.listByProject("company-1", "project-1"),
      queryKeys.issues.detail("task-1"),
      queryKeys.dashboard("company-1"),
      queryKeys.agentChats.list("company-1", "other-viewer"),
      queryKeys.issues.listMineByMe("company-2"),
    ].map(key => watch(key));

    receipt(action, "viewer");

    await vi.waitFor(() => expect(client.getQueryData(mine)).toBe("fresh"));
    ownReads.forEach(read => expect(read).toHaveBeenCalledOnce());
    unrelatedReads.forEach(read => expect(read).not.toHaveBeenCalled());
  });

  it.each(["viewer", "other-viewer"])("keeps company and task audit receipts fresh when %s reads", async reader => {
    const companyActivity = queryKeys.activity("company-1");
    const taskActivity = queryKeys.issues.activity("task-1");
    const otherActivity = queryKeys.issues.activity("other-task");
    const companyRead = watch(companyActivity, [{ action: "issue.read_marked", actorId: reader }]);
    const taskRead = watch(taskActivity, [{ action: "issue.read_marked", actorId: reader }]);
    const otherRead = watch(otherActivity);
    const mineRead = watch(queryKeys.issues.listMineByMe("company-1"));

    receipt("issue.read_marked", reader);

    await vi.waitFor(() => expect(client.getQueryData(companyActivity)).toEqual([{ action: "issue.read_marked", actorId: reader }]));
    await vi.waitFor(() => expect(client.getQueryData(taskActivity)).toEqual([{ action: "issue.read_marked", actorId: reader }]));
    expect(companyRead).toHaveBeenCalledOnce();
    expect(taskRead).toHaveBeenCalledOnce();
    expect(otherRead).not.toHaveBeenCalled();
    expect(mineRead).toHaveBeenCalledTimes(reader === "viewer" ? 1 : 0);
  });

  it("uses the affected person rather than an incidental actor for private read state", async () => {
    const activity = queryKeys.activity("company-1");
    watch(activity);
    const mineRead = watch(queryKeys.issues.listMineByMe("company-1"));
    const badgesRead = watch(queryKeys.sidebarBadges("company-1"));
    const chatRead = watch(queryKeys.agentChats.list("company-1", "viewer"));

    receipt("issue.read_unmarked", "other-viewer", "viewer");

    await vi.waitFor(() => expect(client.getQueryData(activity)).toBe("fresh"));
    for (const read of [mineRead, badgesRead, chatRead]) expect(read).not.toHaveBeenCalled();
  });

  it("refreshes the visible identifier's audit without reloading task detail", async () => {
    const detail = queryKeys.issues.detail("PAP-1");
    client.setQueryData(detail, { id: "task-1", companyId: "company-1", identifier: "PAP-1" });
    const activity = queryKeys.issues.activity("PAP-1");
    const read = watch(activity);
    __liveUpdatesTestUtils.invalidateActivityQueries(client, "company-1", {
      entityType: "issue", entityId: "task-1", action: "issue.read_marked",
      actorType: "user", actorId: "other-viewer", details: { userId: "other-viewer" },
    }, { userId: "viewer", agentId: null }, { pathname: "/PAP/issues/PAP-1", isForegrounded: true });
    await vi.waitFor(() => expect(client.getQueryData(activity)).toBe("fresh"));
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryState(detail)?.isInvalidated).toBe(false);
  });

  it.each(["queued", "failed", "succeeded"])("refreshes combined Mine state after a run becomes %s", async status => {
    const mine = [...queryKeys.issues.listMineByMe("company-1"), "index", 100];
    const next = [{ id: "task-1", companyId: "company-1", status }];
    const read = watch(mine, next);
    const otherCompanyRead = watch(queryKeys.issues.listMineByMe("company-2"));
    __liveUpdatesTestUtils.invalidateHeartbeatQueries(client, "company-1", {
      runId: "run-1", agentId: "agent-1", issueId: "task-1", status,
    });
    await vi.waitFor(() => expect(client.getQueryData(mine)).toEqual(next));
    expect(read).toHaveBeenCalledOnce();
    expect(otherCompanyRead).not.toHaveBeenCalled();
  });

  it("still refreshes ordinary task mutations for every interested view", async () => {
    const list = queryKeys.issues.listByProject("company-1", "project-1");
    const dashboard = queryKeys.dashboard("company-1");
    const detail = queryKeys.issues.detail("task-1");
    const reads = [list, dashboard, detail].map(key => watch(key));
    const otherCompanyRead = watch(queryKeys.issues.list("company-2"));

    receipt("issue.updated", "other-viewer");

    await vi.waitFor(() => expect(client.getQueryData(detail)).toBe("fresh"));
    reads.forEach(read => expect(read).toHaveBeenCalled());
    expect(otherCompanyRead).not.toHaveBeenCalled();
  });
});
