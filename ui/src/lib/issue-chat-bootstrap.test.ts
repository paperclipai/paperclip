// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { Issue, IssueRecentComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "./issue-detail-preload-events";
import {
  CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS,
  CHAT_BOOTSTRAP_SHARE_DEADLINE_MS,
  issueChatBootstrapEntryCountForTest,
  loadIssueChatBootstraps,
  readFromIssueChatBootstrap,
  resetIssueChatBootstrapsForTest,
  startIssueChatBootstrap,
  type ChatBootstrapItem,
} from "./issue-chat-bootstrap";
import { queryKeys } from "./queryKeys";
import { ISSUE_CHAT_BOOTSTRAP_FRESH_MS } from "./issueChatBootstrapCache";

const chatBootstrap = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { chatBootstrap } }));

function idFor(number: number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function item(ref: string, overrides: Partial<ChatBootstrapItem> = {}): ChatBootstrapItem {
  const number = Number(ref.split("-").pop() ?? 1);
  const comment = { id: `comment-${number}`, body: "Latest reply", createdAt: "2026-11-09T00:00:00Z" };
  return {
    ref,
    issue: { id: idFor(number), identifier: `ABC-${number}`, companyId: "company-1", title: `Task ${ref}`, status: "done" } as unknown as Issue,
    recentComments: { comments: [comment], latestCommentId: comment.id, hasMore: false } as unknown as IssueRecentComments,
    commentInputFacts: [{ id: `fact-${number}` }] as never,
    recentActivity: [{ id: `event-${number}` }] as never,
    recentRuns: [{ runId: `run-${number}-b` }, { runId: `run-${number}-a` }] as never,
    interactions: [],
    attachments: [],
    liveRuns: [],
    activeRun: null,
    ...overrides,
  };
}

function respondWith(refs: readonly string[]) {
  return { items: refs.map((ref) => item(ref)) };
}

const requestedRefs = () => chatBootstrap.mock.calls.map((call) => (call[1] as string[]).join(","));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetIssueChatBootstrapsForTest();
  chatBootstrap.mockReset();
  chatBootstrap.mockImplementation(async (_companyId: string, refs: string[]) => respondWith(refs));
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL];
});

describe("loadIssueChatBootstraps", () => {
  it("loads 30 tasks as three requests of ten, one at a time, and seeds the page's keys", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    chatBootstrap.mockImplementation(async (_companyId: string, refs: string[]) => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await Promise.resolve();
      concurrent--;
      return respondWith(refs);
    });
    const refs = Array.from({ length: 30 }, (_, index) => `ABC-${index + 1}`);
    await loadIssueChatBootstraps(client, "company-1", refs);
    expect(chatBootstrap.mock.calls.map((call) => (call[1] as string[]).length)).toEqual([10, 10, 10]);
    expect(chatBootstrap.mock.calls[0]![0]).toBe("company-1");
    expect(chatBootstrap.mock.calls[0]![1][0]).toBe("ABC-1");
    expect(maxConcurrent).toBe(1);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-30"), "core"])).toMatchObject({ identifier: "ABC-30" });
    expect(client.getQueryData([...queryKeys.issues.detail(idFor(30)), "core"])).toMatchObject({ identifier: "ABC-30" });
  });

  it("skips tasks loaded recently and reloads them once they are stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1", "ABC-2"]);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-2", "ABC-3"]);
    expect(requestedRefs()).toEqual(["ABC-1,ABC-2", "ABC-3"]);
    vi.setSystemTime(Date.now() + ISSUE_CHAT_BOOTSTRAP_FRESH_MS + 1);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    expect(requestedRefs()).toEqual(["ABC-1,ABC-2", "ABC-3", "ABC-1"]);
  });

  it("does not load a task again under its other reference (a list by identifier, Recents by id)", async () => {
    await loadIssueChatBootstraps(client, "company-1", ["ABC-4"]);
    await loadIssueChatBootstraps(client, "company-1", [{ id: idFor(4), identifier: "ABC-4" }, { id: idFor(5), identifier: "ABC-5" }]);
    expect(requestedRefs()).toEqual(["ABC-4", idFor(5)]);
  });

  it("does not wait for or repeat a request already in flight for the same task", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const first = loadIssueChatBootstraps(client, "company-1", ["ABC-6"]);
    await Promise.resolve();
    await loadIssueChatBootstraps(client, "company-1", ["abc-6"]);
    expect(chatBootstrap).toHaveBeenCalledOnce();
    answer(respondWith(["ABC-6"]));
    await first;
  });

  it("stops later requests when aborted, but keeps the one in flight usable by the page", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const controller = new AbortController();
    const refs = Array.from({ length: 12 }, (_, index) => `ABC-${index + 1}`);
    const loading = loadIssueChatBootstraps(client, "company-1", refs, { signal: controller.signal });
    await Promise.resolve();
    // The click that opens a task unmounts the list and aborts its preload.
    controller.abort();
    const ownRead = vi.fn();
    const interactions = readFromIssueChatBootstrap(client, ["unread", "ABC-3"], "ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead);
    answer(respondWith(refs.slice(0, 10)));
    await loading;
    await expect(interactions).resolves.toEqual([{ id: "event-3" }]);
    expect(ownRead).not.toHaveBeenCalled();
    expect(chatBootstrap).toHaveBeenCalledOnce();
    expect(chatBootstrap.mock.calls[0]![2]).toBeUndefined();
  });

  it("lets a failed preload fall back to the page's own reads and be retried", async () => {
    chatBootstrap.mockRejectedValueOnce(new Error("busy"));
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    const read = vi.fn().mockResolvedValue("from server");
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-1"], "ABC-1", (bootstrap) => bootstrap.interactions, read)).resolves.toBe("from server");
    expect(read).toHaveBeenCalledOnce();
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
  });

  it("never shares or seeds a task that belongs to another company", async () => {
    chatBootstrap.mockResolvedValueOnce({ items: [item("ABC-7", { issue: { ...item("ABC-7").issue, companyId: "company-2" } })] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-7"]);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-7"), "core"])).toBeUndefined();
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread", "ABC-7"], "ABC-7", (bootstrap) => bootstrap.interactions, read);
    expect(read).toHaveBeenCalledOnce();
  });
});

describe("readFromIssueChatBootstrap", () => {
  it("lets a cold open's reads share one loading bootstrap instead of sending their own", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    void loadIssueChatBootstraps(client, "company-1", ["ABC-9"]);
    await Promise.resolve();
    const ownRead = vi.fn();
    const interactions = readFromIssueChatBootstrap(client, ["unread", "abc-9"], "abc-9", (bootstrap) => bootstrap.interactions, ownRead);
    const activity = readFromIssueChatBootstrap(client, ["unread", "ABC-9"], "ABC-9", (bootstrap) => bootstrap.recentActivity, ownRead);
    answer(respondWith(["ABC-9"]));
    await expect(interactions).resolves.toEqual([]);
    await expect(activity).resolves.toEqual([{ id: "event-9" }]);
    expect(ownRead).not.toHaveBeenCalled();
    expect(chatBootstrap).toHaveBeenCalledOnce();
  });

  it("reads from the server when the bootstrap omits the task, is not loading, or is no longer new", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    chatBootstrap.mockResolvedValueOnce({ items: [] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-4"]);
    const read = vi.fn().mockResolvedValue(["server"]);
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-4"], "ABC-4", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-5"], "ABC-5", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-8"]);
    // A later read of a loaded task is a refresh: it asks the server.
    vi.setSystemTime(Date.now() + 5_000);
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-8"], "ABC-8", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("startIssueChatBootstrap", () => {
  it("adopts the hard load's early fetch instead of sending a request", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "abc-3", promise: Promise.resolve(item("ABC-3")) };
    startIssueChatBootstrap(client, null, "ABC-3");
    const ownRead = vi.fn();
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-3"], "ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead)).resolves.toEqual([{ id: "event-3" }]);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toMatchObject({ identifier: "ABC-3" });
    expect(chatBootstrap).not.toHaveBeenCalled();
    expect(ownRead).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL]).toBeUndefined();
  });

  it("does not use an early answer for a task of another company than the page's", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", promise: Promise.resolve(item("ABC-3")) };
    startIssueChatBootstrap(client, "company-2", "ABC-3");
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread", "ABC-3"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toBeUndefined();
  });

  it("falls back to the page's reads when the early fetch failed", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", promise: Promise.resolve(null) };
    startIssueChatBootstrap(client, null, "ABC-3");
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread", "ABC-3"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("ignores an early fetch for another task and loads this one through the company endpoint", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-1", promise: Promise.resolve(item("ABC-1")) };
    startIssueChatBootstrap(client, "company-1", "ABC-2");
    await Promise.resolve();
    await expect(readFromIssueChatBootstrap(client, ["unread", "ABC-2"], "ABC-2", (bootstrap) => bootstrap.issue.identifier, vi.fn())).resolves.toBe("ABC-2");
    expect(requestedRefs()).toEqual(["ABC-2"]);
  });
});

describe("background preloads", () => {
  it("do not preload a task again for five minutes while a list stays open, but an open still loads it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1", "ABC-2"], { background: true });
    // Past the 30-second freshness: the list re-renders after a live reorder.
    vi.setSystemTime(Date.now() + ISSUE_CHAT_BOOTSTRAP_FRESH_MS + 1);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-2", "ABC-1", "ABC-3"], { background: true });
    expect(requestedRefs()).toEqual(["ABC-1,ABC-2", "ABC-3"]);
    // Open intent is not a background preload.
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    expect(requestedRefs()).toEqual(["ABC-1,ABC-2", "ABC-3", "ABC-1"]);
    vi.setSystemTime(Date.now() + CHAT_BOOTSTRAP_BACKGROUND_REPEAT_MS);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-2"], { background: true });
    expect(requestedRefs()).toEqual(["ABC-1,ABC-2", "ABC-3", "ABC-1", "ABC-2"]);
  });

  it("leave a seeded key that a live event invalidated to the page's own read", async () => {
    await loadIssueChatBootstraps(client, "company-1", ["ABC-4"], { background: true });
    const key = queryKeys.issues.interactions("ABC-4");
    // An event for this task (the fast live lane) marks the seeded key stale.
    await client.invalidateQueries({ queryKey: key });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    const read = vi.fn().mockResolvedValue([{ id: "new" }]);
    await expect(readFromIssueChatBootstrap(client, key, "ABC-4", (bootstrap) => bootstrap.interactions, read)).resolves.toEqual([{ id: "new" }]);
    expect(read).toHaveBeenCalledOnce();
  });
});

describe("safeguards", () => {
  it("does not request a task again by its identifier while its id's request is in flight", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    // Recents asks by id (and knows the identifier); the list then asks by identifier.
    const recents = loadIssueChatBootstraps(client, "company-1", [{ id: idFor(5), identifier: "ABC-5" }]);
    await Promise.resolve();
    await loadIssueChatBootstraps(client, "company-1", ["ABC-5"]);
    expect(chatBootstrap).toHaveBeenCalledOnce();
    answer({ items: [item("ABC-5", { ref: idFor(5) })] });
    await recents;
  });

  it("stops waiting for a stalled bootstrap, so the page and its Retry read the server", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    chatBootstrap.mockImplementationOnce(() => new Promise(() => {}));
    void loadIssueChatBootstraps(client, "company-1", ["ABC-6"]);
    await Promise.resolve();
    const read = vi.fn().mockResolvedValue(["server"]);
    const first = readFromIssueChatBootstrap(client, ["unread"], "ABC-6", (bootstrap) => bootstrap.attachments, read);
    await vi.advanceTimersByTimeAsync(CHAT_BOOTSTRAP_SHARE_DEADLINE_MS);
    await expect(first).resolves.toEqual(["server"]);
    // A retry does not join the stuck request again.
    await expect(readFromIssueChatBootstrap(client, ["unread"], "ABC-6", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("never shares a bootstrap with a refresh of a key that already holds data", async () => {
    let answer!: (value: unknown) => void;
    chatBootstrap.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    void loadIssueChatBootstraps(client, "company-1", ["ABC-9"]);
    await Promise.resolve();
    // An accepted confirmation was written and its key invalidated: the refresh
    // must read the server, not the bootstrap's older pending interaction.
    const key = queryKeys.issues.interactions("ABC-9");
    client.setQueryData(key, [{ id: "accepted" }]);
    const read = vi.fn().mockResolvedValue([{ id: "accepted" }]);
    await expect(readFromIssueChatBootstrap(client, key, "ABC-9", (bootstrap) => bootstrap.interactions, read)).resolves.toEqual([{ id: "accepted" }]);
    expect(read).toHaveBeenCalledOnce();
    answer(respondWith(["ABC-9"]));
  });

  it("never gives one account's bootstrap to another account", async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-3"]);
    client.clear();
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    const read = vi.fn().mockResolvedValue(["server"]);
    await expect(readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    expect(read).toHaveBeenCalledOnce();
    // The new account loads the task for itself.
    await loadIssueChatBootstraps(client, "company-1", ["ABC-3"]);
    expect(requestedRefs()).toEqual(["ABC-3", "ABC-3"]);
  });

  it("drops an early answer when the account changes before it arrives", async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    let answer!: (value: unknown) => void;
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = {
      ref: "ABC-3", startedAt: Date.now(), promise: new Promise((resolve) => { answer = resolve; }),
    };
    startIssueChatBootstrap(client, null, "ABC-3");
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    answer(item("ABC-3"));
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toBeUndefined();
  });

  it("binds an early answer adopted before the session loaded to the first account that uses it", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", startedAt: Date.now(), promise: Promise.resolve(item("ABC-3")) };
    // The page renders the task before its first session read finishes.
    await startIssueChatBootstrap(client, null, "ABC-3");
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const ownRead = vi.fn();
    await expect(readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead)).resolves.toEqual([{ id: "event-3" }]);
    expect(ownRead).not.toHaveBeenCalled();
    // Once used by user-1, another account cannot use it.
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("never seeds a pre-session early answer after a sign-out, nor for the next account", async () => {
    let answer!: (value: unknown) => void;
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = {
      ref: "ABC-3", startedAt: Date.now(), promise: new Promise((resolve) => { answer = resolve; }),
    };
    // Adopted before the first session read finishes.
    startIssueChatBootstrap(client, null, "ABC-3");
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    // user-1 signs out, then user-2 signs in, before the answer arrives.
    client.setQueryData(queryKeys.auth.session, null);
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    answer(item("ABC-3"));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toBeUndefined();
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("revokes a pre-session early answer when the first session has no user", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", startedAt: Date.now(), promise: new Promise(() => {}) };
    startIssueChatBootstrap(client, null, "ABC-3");
    client.setQueryData(queryKeys.auth.session, null);
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap(client, ["unread"], "ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("stamps an early answer with its request time and ignores one that is already stale", async () => {
    const startedAt = Date.now() - 5_000;
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", startedAt, promise: Promise.resolve(item("ABC-3")) };
    await startIssueChatBootstrap(client, null, "ABC-3");
    expect(client.getQueryState([...queryKeys.issues.detail("ABC-3"), "core"])?.dataUpdatedAt).toBe(startedAt);

    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = {
      ref: "ABC-4", startedAt: Date.now() - ISSUE_CHAT_BOOTSTRAP_FRESH_MS - 1, promise: Promise.resolve(item("ABC-4")),
    };
    startIssueChatBootstrap(client, "company-1", "ABC-4");
    await Promise.resolve();
    // The page read the task itself instead of seeding the stale answer.
    expect(requestedRefs()).toEqual(["ABC-4"]);
  });

  it("drops expired answers so they do not stay in memory", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    await Promise.resolve();
    vi.setSystemTime(Date.now() + ISSUE_CHAT_BOOTSTRAP_FRESH_MS + 1);
    client.clear();
    await loadIssueChatBootstraps(client, "company-1", ["ABC-2"]);
    await Promise.resolve();
    // Only ABC-2 remains, under its identifier and its id.
    expect(issueChatBootstrapEntryCountForTest()).toBe(2);
  });
});
