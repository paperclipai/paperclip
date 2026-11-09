// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { Issue, IssueRecentComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { issueCommentInputFactsQueryKey, recentIssueActivityQueryKey, recentIssueRunWindowQueryKey } from "./issue-chat-history-queries";
import {
  CHAT_BOOTSTRAP_FRESH_MS,
  loadIssueChatBootstraps,
  readFromIssueChatBootstrap,
  resetIssueChatBootstrapsForTest,
  seedIssueChatBootstrap,
  startIssueChatBootstrap,
  type ChatBootstrapItem,
} from "./issue-chat-bootstrap";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "./issue-detail-preload-events";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/client", () => ({ api: { get: vi.fn() } }));

function item(ref: string, overrides: Partial<ChatBootstrapItem> = {}): ChatBootstrapItem {
  const number = Number(ref.split("-")[1] ?? 1);
  const id = `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
  const comment = { id: `comment-${number}`, body: "Latest reply", createdAt: "2026-11-09T00:00:00Z" };
  return {
    ref,
    issue: { id, identifier: ref, companyId: "company-1", title: `Task ${ref}`, status: "done" } as unknown as Issue,
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

function respondWith(refs: string[]) {
  return { items: refs.map((ref) => item(ref)) };
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  resetIssueChatBootstrapsForTest();
  vi.mocked(api.get).mockReset();
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
});

describe("seedIssueChatBootstrap", () => {
  it("fills every key the compact chat waits on, under the route ref and the UUID", () => {
    const seeded = item("ABC-7");
    seedIssueChatBootstrap(client, seeded, 1_000);
    for (const ref of ["ABC-7", seeded.issue.id]) {
      expect(client.getQueryData([...queryKeys.issues.detail(ref), "core"])).toBe(seeded.issue);
      expect(client.getQueryData([...queryKeys.issues.comments(ref), "recent"])).toBe(seeded.recentComments);
      expect(client.getQueryData(recentIssueActivityQueryKey(ref))).toBe(seeded.recentActivity);
      // Same window the page builds from a first read: the latest run, with evidence of an earlier one.
      expect(client.getQueryData(recentIssueRunWindowQueryKey(ref))).toEqual({ runs: [{ runId: "run-7-b" }], hasEarlierRuns: true });
      expect(client.getQueryData(queryKeys.issues.interactions(ref))).toEqual([]);
      expect(client.getQueryData(queryKeys.issues.attachments(ref))).toEqual([]);
      expect(client.getQueryData(queryKeys.issues.liveRuns(ref))).toEqual([]);
      expect(client.getQueryData(queryKeys.issues.activeRun(ref))).toBeNull();
      const factsKey = issueCommentInputFactsQueryKey(ref);
      expect(client.getQueryData([...factsKey, "batch-ids"])).toEqual([["comment-7"]]);
      expect(client.getQueryData([...factsKey, "batch", ["comment-7"]])).toEqual([{ id: "fact-7" }]);
    }
  });

  it("keeps windows the page already merged and newer answers the page already read", () => {
    const earlierWindow = { comments: [{ id: "older" }], latestCommentId: "older", hasMore: true };
    client.setQueryData([...queryKeys.issues.comments("ABC-7"), "recent"], earlierWindow);
    client.setQueryData(queryKeys.issues.interactions("ABC-7"), ["newer"], { updatedAt: 5_000 });
    client.setQueryData(queryKeys.issues.attachments("ABC-7"), ["older"], { updatedAt: 500 });
    seedIssueChatBootstrap(client, item("ABC-7"), 1_000);
    expect(client.getQueryData([...queryKeys.issues.comments("ABC-7"), "recent"])).toBe(earlierWindow);
    expect(client.getQueryData(queryKeys.issues.interactions("ABC-7"))).toEqual(["newer"]);
    expect(client.getQueryData(queryKeys.issues.attachments("ABC-7"))).toEqual([]);
  });
});

describe("loadIssueChatBootstraps", () => {
  it("preloads 30 tasks as three requests of ten, one at a time", async () => {
    const inFlight: string[][] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      const refs = decodeURIComponent(path.split("ids=")[1]!).split(",");
      inFlight.push(refs);
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await Promise.resolve();
      concurrent--;
      return respondWith(refs);
    });
    const refs = Array.from({ length: 30 }, (_, index) => `ABC-${index + 1}`);
    await loadIssueChatBootstraps(client, "company-1", refs);
    expect(inFlight.map((chunk) => chunk.length)).toEqual([10, 10, 10]);
    expect(inFlight[0]![0]).toBe("ABC-1");
    expect(maxConcurrent).toBe(1);
    expect(vi.mocked(api.get).mock.calls[0]![0]).toMatch(/^\/companies\/company-1\/issues\/chat-bootstrap\?ids=/);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-30"), "core"])).toMatchObject({ identifier: "ABC-30" });
  });

  it("skips tasks preloaded recently and reloads them once they are stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(api.get).mockImplementation(async (path: string) => respondWith(decodeURIComponent(path.split("ids=")[1]!).split(",")));
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1", "ABC-2"]);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-2", "ABC-3"]);
    expect(vi.mocked(api.get).mock.calls.map((call) => call[0].split("ids=")[1])).toEqual(["ABC-1,ABC-2", "ABC-3"]);
    vi.setSystemTime(Date.now() + CHAT_BOOTSTRAP_FRESH_MS + 1);
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    expect(vi.mocked(api.get)).toHaveBeenCalledTimes(3);
  });

  it("lets a failed preload fall back to the page's own reads", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("busy"));
    await loadIssueChatBootstraps(client, "company-1", ["ABC-1"]);
    const read = vi.fn().mockResolvedValue("from server");
    await expect(readFromIssueChatBootstrap("ABC-1", (bootstrap) => bootstrap.interactions, read)).resolves.toBe("from server");
    expect(read).toHaveBeenCalledOnce();
  });
});

describe("readFromIssueChatBootstrap", () => {
  it("lets a cold open's reads share one loading bootstrap instead of sending their own", async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api.get).mockReturnValue(new Promise((resolve) => { answer = resolve; }) as never);
    void loadIssueChatBootstraps(client, "company-1", ["ABC-9"]);
    const ownRead = vi.fn();
    const interactions = readFromIssueChatBootstrap("abc-9", (bootstrap) => bootstrap.interactions, ownRead);
    const activity = readFromIssueChatBootstrap("ABC-9", (bootstrap) => bootstrap.recentActivity, ownRead);
    answer(respondWith(["ABC-9"]));
    await expect(interactions).resolves.toEqual([]);
    await expect(activity).resolves.toEqual([{ id: "event-9" }]);
    expect(ownRead).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it("reads from the server when the bootstrap omits the task or is not loading", async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [] });
    await loadIssueChatBootstraps(client, "company-1", ["ABC-4"]);
    const read = vi.fn().mockResolvedValue(["server"]);
    await expect(readFromIssueChatBootstrap("ABC-4", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    await expect(readFromIssueChatBootstrap("ABC-5", (bootstrap) => bootstrap.attachments, read)).resolves.toEqual(["server"]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("startIssueChatBootstrap", () => {
  it("adopts the hard load's early fetch instead of sending a request", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "abc-3", promise: Promise.resolve(item("ABC-3")) };
    startIssueChatBootstrap(client, null, "ABC-3");
    const ownRead = vi.fn();
    await expect(readFromIssueChatBootstrap("ABC-3", (bootstrap) => bootstrap.recentActivity, ownRead)).resolves.toEqual([{ id: "event-3" }]);
    expect(client.getQueryData([...queryKeys.issues.detail("ABC-3"), "core"])).toMatchObject({ identifier: "ABC-3" });
    expect(api.get).not.toHaveBeenCalled();
    expect(ownRead).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL]).toBeUndefined();
  });

  it("ignores an early fetch for another task and loads this one through the company endpoint", async () => {
    (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-1", promise: Promise.resolve(item("ABC-1")) };
    vi.mocked(api.get).mockResolvedValue(respondWith(["ABC-2"]));
    startIssueChatBootstrap(client, "company-1", "ABC-2");
    await expect(readFromIssueChatBootstrap("ABC-2", (bootstrap) => bootstrap.issue.identifier, vi.fn())).resolves.toBe("ABC-2");
    expect(api.get).toHaveBeenCalledOnce();
    delete (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL];
  });
});
