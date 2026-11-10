// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { Issue, IssueRecentComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "./issue-detail-preload-events";
import {
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
    const interactions = readFromIssueChatBootstrap("ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead);
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
    await expect(readFromIssueChatBootstrap("ABC-1", (bootstrap) => bootstrap.interactions, read)).resolves.toBe("from server");
    expect(read).toHaveBeenCalledOnce();
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    expect(chatBootstrap).toHaveBeenCalledTimes(2);
  });

  it("never shares or seeds a task that belongs to another company", async () => {
    chatBootstrap.mockResolvedValueOnce({ items: [item("ABC-7", { issue: { ...item("ABC-7").issue, companyId: "company-2" } })] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-7"]);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-7"), "core"])).toBeUndefined();
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap("ABC-7", (bootstrap) => bootstrap.interactions, read);
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
    const interactions = readFromIssueChatBootstrap("abc-9", (bootstrap) => bootstrap.interactions, ownRead);
    const activity = readFromIssueChatBootstrap("ABC-9", (bootstrap) => bootstrap.recentActivity, ownRead);
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
    await expect(readFromIssueChatBootstrap("ABC-4", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    await expect(readFromIssueChatBootstrap("ABC-5", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-8"]);
    // A later read of a loaded task is a refresh: it asks the server.
    vi.setSystemTime(Date.now() + 5_000);
    await expect(readFromIssueChatBootstrap("ABC-8", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe("startIssueChatBootstrap", () => {
  it("adopts the hard load's early fetch instead of sending a request", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "abc-3", promise: Promise.resolve(item("ABC-3")) };
    startIssueChatBootstrap(client, null, "ABC-3");
    const ownRead = vi.fn();
    await expect(readFromIssueChatBootstrap("ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead)).resolves.toEqual([{ id: "event-3" }]);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toMatchObject({ identifier: "ABC-3" });
    expect(chatBootstrap).not.toHaveBeenCalled();
    expect(ownRead).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL]).toBeUndefined();
  });

  it("does not use an early answer for a task of another company than the page's", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", promise: Promise.resolve(item("ABC-3")) };
    startIssueChatBootstrap(client, "company-2", "ABC-3");
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap("ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toBeUndefined();
  });

  it("falls back to the page's reads when the early fetch failed", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-3", promise: Promise.resolve(null) };
    startIssueChatBootstrap(client, null, "ABC-3");
    const read = vi.fn().mockResolvedValue([]);
    await readFromIssueChatBootstrap("ABC-3", (bootstrap) => bootstrap.recentActivity, read);
    expect(read).toHaveBeenCalledOnce();
  });

  it("ignores an early fetch for another task and loads this one through the company endpoint", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-1", promise: Promise.resolve(item("ABC-1")) };
    startIssueChatBootstrap(client, "company-1", "ABC-2");
    await Promise.resolve();
    await expect(readFromIssueChatBootstrap("ABC-2", (bootstrap) => bootstrap.issue.identifier, vi.fn())).resolves.toBe("ABC-2");
    expect(requestedRefs()).toEqual(["ABC-2"]);
  });
});
