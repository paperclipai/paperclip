// @vitest-environment jsdom

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Issue, IssueRecentComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "./issue-detail-preload-events";
import { resetIssueChatBootstrapsForTest, startIssueChatBootstrap, type ChatBootstrapItem } from "./issue-chat-bootstrap";
import { fetchRecentIssueActivity, issueCommentInputFactsQueryKey, recentIssueActivityQueryKey, recentIssueRunWindowQueryKey } from "./issue-chat-history-queries";
import { getIssueRecentCommentsQueryOptions } from "./issue-comment-window-query";
import {
  clearPersistedQueryCache,
  isRestoredSavedRead,
  QUERY_CACHE_MAX_AGE,
  recordTaskOpen,
  QUERY_CACHE_PREFIX,
  SAVED_TASK_CHAT_MAX_BYTES,
  SAVED_TASK_CHAT_MAX_COMMENTS,
  SAVED_TASK_CHAT_MAX_TASK_BYTES,
  startPersistedQueryCache,
  taskChatFirstFrameRef,
} from "./persisted-query-cache";
import { queryKeys } from "./queryKeys";

// The first chat frame of a recently opened task is saved with the rest of
// the read cache, so a hard load shows it before any response. The owner
// approved saving recent comments on 2026-11-14, within these guardrails.

const api = vi.hoisted(() => ({ chatBootstrap: vi.fn(), getSession: vi.fn(), recentComments: vi.fn(), listComments: vi.fn(), recentForIssue: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { chatBootstrap: api.chatBootstrap, recentComments: api.recentComments, listComments: api.listComments } }));
vi.mock("@/api/activity", () => ({ activityApi: { recentForIssue: api.recentForIssue } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.getSession } }));

class MemoryStorage {
  values = new Map<string, string>();
  quota = Number.POSITIVE_INFINITY;
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (value.length > this.quota) throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
  text() { return [...this.values.values()].join(" "); }
}

const COMPANY = "company-one";
const session = (id: string) => ({ session: { id: `session-${id}`, userId: id }, user: { id, name: id, email: `${id}@example.test`, image: null } });
const coreKey = (ref: string) => [...queryKeys.issues.detail(ref), "core"];
const commentsKey = (ref: string) => [...queryKeys.issues.comments(ref), "recent"];
const task = (n: number, companyId = COMPANY) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `ABC-${n}`, companyId, title: `Task ${n}`, status: "todo" });

function recentComments(n: number, count = 3, body = "Saved reply"): IssueRecentComments {
  const comments = Array.from({ length: count }, (_, index) => ({ id: `comment-${n}-${index}`, body: `${body} ${index}`, createdAt: "2026-11-14T00:00:00Z" }));
  return { comments, latestCommentId: comments.at(-1)?.id ?? null, oldestCommentId: comments[0]?.id ?? null, hasMore: false } as unknown as IssueRecentComments;
}

const handles: Array<() => void> = [];
function page(storage: MemoryStorage, options: { now?: () => number; user?: string | null; companies?: string[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.user) client.setQueryData(queryKeys.auth.session, session(options.user));
  const handle = startPersistedQueryCache(client, { storage, now: options.now, buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
  handles.push(() => { handle.dispose(); client.clear(); });
  return { client, handle };
}

function signIn(client: QueryClient, user = "alice", companies = [COMPANY]) {
  client.setQueryData(queryKeys.auth.session, session(user));
  client.setQueryData(queryKeys.companies.list(user), { companies: companies.map((id) => ({ id, name: id })), unauthorized: false });
}

/** A task the user opened: its record and its first chat frame. */
function openTask(client: QueryClient, n: number, options: { companyId?: string; comments?: IssueRecentComments; updatedAt?: number } = {}) {
  const issue = task(n, options.companyId);
  const at = { updatedAt: options.updatedAt ?? Date.now() };
  client.setQueryData(coreKey(issue.identifier), issue, at);
  client.setQueryData(coreKey(issue.id), issue, at);
  client.setQueryData(commentsKey(issue.identifier), options.comments ?? recentComments(n), at);
  client.setQueryData(recentIssueActivityQueryKey(issue.identifier), [{ id: `event-${n}` }], at);
  client.setQueryData(recentIssueRunWindowQueryKey(issue.identifier), { runs: [] }, at);
  client.setQueryData([...issueCommentInputFactsQueryKey(issue.identifier), "batch-ids"], [[`comment-${n}-0`]], at);
  client.setQueryData([...issueCommentInputFactsQueryKey(issue.identifier), "batch", [`comment-${n}-0`]], [], at);
  client.setQueryData(queryKeys.issues.interactions(issue.identifier), [], at);
  client.setQueryData(queryKeys.issues.attachments(issue.identifier), [{ id: `attachment-${n}`, originalFilename: "notes.txt", contentPath: "/api/attachments/x/content" }], at);
  client.setQueryData(queryKeys.issues.liveRuns(issue.identifier), [], at);
  client.setQueryData(queryKeys.issues.workProducts(issue.identifier), [], at);
  client.setQueryData([...queryKeys.issues.documents(issue.id), "plan"], { key: "plan", body: "# Plan" }, at);
  return issue;
}

function savedPage(setup: (client: QueryClient) => void, storage = new MemoryStorage()) {
  const first = page(storage);
  signIn(first.client);
  setup(first.client);
  first.handle.flush();
  return storage;
}

beforeEach(() => {
  resetIssueChatBootstrapsForTest();
  api.chatBootstrap.mockReset();
});
afterEach(() => {
  for (const dispose of handles.splice(0)) dispose();
  delete (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL];
  vi.useRealTimers();
});

describe("saved first chat frame of a recently opened task", () => {
  it("is restored on the next hard load, shown at once and marked for revalidation", () => {
    const storage = savedPage((client) => { openTask(client, 1); });
    const { client } = page(storage);
    expect(client.getQueryData(commentsKey("ABC-1"))).toMatchObject({ latestCommentId: "comment-1-2" });
    for (const key of [commentsKey("ABC-1"), recentIssueActivityQueryKey("ABC-1"), queryKeys.issues.liveRuns("ABC-1"), [...queryKeys.issues.documents(task(1).id), "plan"]]) {
      expect(isRestoredSavedRead(client, key)).toBe(true);
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
  });

  it("recognises exactly the first-frame reads", () => {
    expect(taskChatFirstFrameRef(commentsKey("ABC-1"))).toBe("ABC-1");
    expect(taskChatFirstFrameRef([...issueCommentInputFactsQueryKey("ABC-1"), "batch", ["c"]])).toBe("ABC-1");
    expect(taskChatFirstFrameRef(queryKeys.issues.comments("ABC-1"))).toBeNull();
    expect(taskChatFirstFrameRef([...queryKeys.issues.comments("ABC-1"), "earlier"])).toBeNull();
    expect(taskChatFirstFrameRef(queryKeys.issues.activity("ABC-1"))).toBeNull();
    expect(taskChatFirstFrameRef(queryKeys.issues.queuedComments("ABC-1"))).toBeNull();
    expect(taskChatFirstFrameRef([...queryKeys.issues.documents("ABC-1")])).toBeNull();
  });

  describe("bounds", () => {
    it("keeps only the newest comments of a long window and says more exist", () => {
      const storage = savedPage((client) => { openTask(client, 1, { comments: recentComments(1, SAVED_TASK_CHAT_MAX_COMMENTS + 10) }); });
      const restored = page(storage).client.getQueryData<IssueRecentComments>(commentsKey("ABC-1"))!;
      expect(restored.comments).toHaveLength(SAVED_TASK_CHAT_MAX_COMMENTS);
      expect(restored.comments.at(-1)).toMatchObject({ id: `comment-1-${SAVED_TASK_CHAT_MAX_COMMENTS + 9}` });
      expect(restored).toMatchObject({ hasMore: true, oldestCommentId: "comment-1-10" });
    });

    it("saves chat only for the twenty most recently opened tasks", () => {
      const start = Date.now() - 60_000;
      const storage = savedPage((client) => { for (let n = 1; n <= 21; n += 1) openTask(client, n, { updatedAt: start + n * 1_000 }); });
      const { client } = page(storage);
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      expect(client.getQueryData(coreKey("ABC-1"))).toBeUndefined();
      // Nothing of the older task's chat is left on disk either.
      expect(storage.text()).not.toContain("comment-1-0");
      for (const n of [2, 21]) expect(client.getQueryData(commentsKey(`ABC-${n}`))).toBeDefined();
    });

    it("keeps a task the user opened over newer tasks a list only preloaded, across loads", async () => {
      const storage = new MemoryStorage();
      const first = page(storage);
      signIn(first.client);
      openTask(first.client, 1, { updatedAt: Date.now() - 30_000 });
      recordTaskOpen(first.client, task(1));
      const stops = Array.from({ length: 25 }, (_, index) => {
        const preloaded = openTask(first.client, 100 + index);
        return new QueryObserver(first.client, { queryKey: coreKey(preloaded.identifier), enabled: false }).subscribe(() => {});
      });
      first.handle.flush();
      for (const stop of stops) stop();
      expect(storage.text()).toContain("comment-1-0");

      const second = page(storage);
      await second.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session("alice") });
      signIn(second.client);
      for (let n = 200; n < 225; n += 1) openTask(second.client, n);
      second.handle.flush();
      expect(storage.text()).toContain("comment-1-0");
      expect(page(storage).client.getQueryData(commentsKey("ABC-1"))).toBeDefined();
    });

    it("ranks a task opened by a lowercase identifier as opened", () => {
      const storage = new MemoryStorage();
      const first = page(storage);
      signIn(first.client);
      const opened = task(1);
      first.client.setQueryData(coreKey("abc-1"), opened, { updatedAt: Date.now() - 30_000 });
      first.client.setQueryData(commentsKey("abc-1"), recentComments(1), { updatedAt: Date.now() - 30_000 });
      recordTaskOpen(first.client, opened);
      for (let n = 100; n < 125; n += 1) openTask(first.client, n);
      first.handle.flush();
      expect(page(storage).client.getQueryData(commentsKey("abc-1"))).toBeDefined();
    });

    it("never carries one user's opened tasks into another user's record", async () => {
      const storage = new MemoryStorage();
      const { client, handle } = page(storage);
      signIn(client, "alice");
      recordTaskOpen(client, openTask(client, 1));
      handle.flush();
      expect(JSON.parse(storage.getItem(`${QUERY_CACHE_PREFIX}alice:${COMPANY}`)!).visits).toHaveProperty(task(1).id);
      await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session("bob") });
      signIn(client, "bob");
      openTask(client, 1);
      handle.flush();
      expect(JSON.parse(storage.getItem(`${QUERY_CACHE_PREFIX}bob:${COMPANY}`)!).visits).toEqual({});
    });

    it("forgets when a refused task was opened", async () => {
      const storage = new MemoryStorage();
      const { client, handle } = page(storage);
      signIn(client);
      recordTaskOpen(client, openTask(client, 1));
      recordTaskOpen(client, openTask(client, 2));
      await client.fetchQuery({ queryKey: coreKey("ABC-1"), queryFn: async () => { throw new ApiError("Forbidden", 403, null); } }).catch(() => {});
      handle.flush();
      const visits = JSON.parse(storage.getItem(`${QUERY_CACHE_PREFIX}alice:${COMPANY}`)!).visits;
      expect(visits).not.toHaveProperty(task(1).id);
      expect(visits).toHaveProperty(task(2).id);
    });

    it("skips a task whose chat exceeds the per-task budget and keeps its record", () => {
      const huge = recentComments(1, 3, "x".repeat(SAVED_TASK_CHAT_MAX_TASK_BYTES));
      const storage = savedPage((client) => { openTask(client, 1, { comments: huge }); openTask(client, 2); });
      const { client } = page(storage);
      expect(client.getQueryData(coreKey("ABC-1"))).toBeDefined();
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      expect(client.getQueryData(commentsKey("ABC-2"))).toBeDefined();
    });

    it("stops at the total budget, newest tasks first", () => {
      const body = "y".repeat(Math.floor(SAVED_TASK_CHAT_MAX_TASK_BYTES * 0.8));
      const count = Math.ceil(SAVED_TASK_CHAT_MAX_BYTES / (SAVED_TASK_CHAT_MAX_TASK_BYTES * 0.8)) + 2;
      const start = Date.now() - 60_000;
      const storage = savedPage((client) => {
        for (let n = 1; n <= count; n += 1) openTask(client, n, { comments: recentComments(n, 1, body), updatedAt: start + n * 1_000 });
      });
      const { client } = page(storage);
      expect(client.getQueryData(commentsKey(`ABC-${count}`))).toBeDefined();
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      const savedChars = [...storage.values.values()].reduce((sum, value) => sum + value.length, 0);
      expect(savedChars).toBeLessThan(SAVED_TASK_CHAT_MAX_BYTES + 256 * 1024);
    });

    it("keeps the rest of the record when storage refuses the saved chat", () => {
      const storage = new MemoryStorage();
      const withoutChat = savedPage((client) => { openTask(client, 1); }, new MemoryStorage());
      const plainRecord = [...withoutChat.values.entries()].find(([key]) => key.endsWith(`:${COMPANY}`))![1];
      // Room for the record, not for its saved chat.
      storage.quota = plainRecord.length - 200;
      savedPage((client) => { openTask(client, 1); }, storage);
      const { client } = page(storage);
      expect(client.getQueryData(coreKey("ABC-1"))).toMatchObject({ title: "Task 1" });
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
    });
  });

  it("expires a fixed time after it was read, even while the rest of the cache stays current", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    let now = start;
    const storage = new MemoryStorage();
    const first = page(storage, { now: () => now });
    signIn(first.client);
    openTask(first.client, 1, { updatedAt: now });
    first.handle.flush();
    // A later visit reads the session and companies again and saves, but not the task's chat.
    now = start + QUERY_CACHE_MAX_AGE / 2;
    vi.setSystemTime(now);
    const second = page(storage, { now: () => now });
    // The session read verifies the restored account, so this visit saves again.
    await second.client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: async () => session("alice") });
    signIn(second.client);
    expect(second.client.getQueryData(commentsKey("ABC-1"))).toBeDefined();
    second.handle.flush();
    now = start + QUERY_CACHE_MAX_AGE + 1;
    vi.setSystemTime(now);
    const { client } = page(storage, { now: () => now });
    expect(client.getQueryData(queryKeys.companies.list("alice"))).toBeDefined();
    expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
  });

  describe("revocation", () => {
    it.each([403, 404, 401])("removes the task's saved chat at once after a %s on its revalidation", async (status) => {
      const storage = savedPage((client) => { openTask(client, 1); openTask(client, 2); });
      const { client } = page(storage);
      await client.fetchQuery({ queryKey: commentsKey("ABC-1"), queryFn: async () => { throw new ApiError("Refused", status, null); } }).catch(() => {});
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      expect(client.getQueryData(coreKey("ABC-1"))).toBeUndefined();
      expect(storage.text()).not.toContain("comment-1-0");
      expect(storage.text()).toContain("comment-2-0");
      const reloaded = page(storage).client;
      expect(reloaded.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      expect(reloaded.getQueryData(commentsKey("ABC-2"))).toBeDefined();
    });

    it.each([
      ["a missing plan", [...queryKeys.issues.documents(task(1).id), "plan"]],
      ["a missing active run", queryKeys.issues.activeRun("ABC-1")],
      ["missing work products", queryKeys.issues.workProducts("ABC-1")],
    ])("keeps the task after a 404 for %s, which does not mean the task is gone", async (_name, key) => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      await client.fetchQuery({ queryKey: key as readonly unknown[], queryFn: async () => { throw new ApiError("Not found", 404, null); } }).catch(() => {});
      expect(client.getQueryData(coreKey("ABC-1"))).toBeDefined();
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeDefined();
      expect(storage.text()).toContain("comment-1-0");
    });

    it("removes the saved chat when the task record itself is refused", async () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      await client.fetchQuery({ queryKey: coreKey("ABC-1"), queryFn: async () => { throw new ApiError("Forbidden", 403, null); } }).catch(() => {});
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
      expect(storage.text()).not.toContain("comment-1-0");
      expect(page(storage).client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
    });
  });

  describe("isolation", () => {
    it("is cleared on sign-out", () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      clearPersistedQueryCache(client);
      expect(storage.text()).not.toContain("comment-1-0");
      expect(page(storage).client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
    });

    it("is never restored for another user", () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage, { user: "bob" });
      expect(client.getQueryData(commentsKey("ABC-1"))).toBeUndefined();
    });

    it("is saved in its task's company record and never in another company's", () => {
      const storage = new MemoryStorage();
      const first = page(storage);
      signIn(first.client, "alice", [COMPANY, "company-two"]);
      openTask(first.client, 1);
      openTask(first.client, 2, { companyId: "company-two" });
      first.handle.flush();
      const record = (companyId: string) => storage.getItem(`${QUERY_CACHE_PREFIX}alice:${companyId}`) ?? "";
      expect(record(COMPANY)).toContain("comment-1-0");
      expect(record(COMPANY)).not.toContain("comment-2-0");
      expect(record("company-two")).toContain("comment-2-0");
      expect(record("company-two")).not.toContain("comment-1-0");
    });

    it("is not saved for a task whose company the user no longer has", () => {
      const storage = savedPage((client) => { openTask(client, 3, { companyId: "company-gone" }); });
      expect(storage.text()).not.toContain("comment-3-0");
    });
  });

  it("saves only what the first frame shows: no secrets or excluded fields", () => {
    const storage = savedPage((client) => {
      openTask(client, 1, { comments: { ...recentComments(1), comments: [{ id: "c", body: "Visible", token: "secret-token", apiKey: "secret-key", documents: [{ body: "doc" }] }] } as unknown as IssueRecentComments });
      client.setQueryData(recentIssueRunWindowQueryKey("ABC-1"), { runs: [{ id: "r", env: { SECRET: "secret-env" }, credentials: "secret-creds" }] });
    });
    expect(storage.text()).toContain("Visible");
    for (const secret of ["secret-token", "secret-key", "secret-env", "secret-creds", "\"documents\":"]) expect(storage.text()).not.toContain(secret);
  });

  describe("freshness", () => {
    it("never replaces newer data already in the page", () => {
      const storage = savedPage((client) => { openTask(client, 1, { updatedAt: Date.now() - 10_000 }); });
      const client = new QueryClient();
      client.setQueryData(commentsKey("ABC-1"), recentComments(1, 1, "Newer from the server"));
      const handle = startPersistedQueryCache(client, { storage, buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
      handles.push(() => { handle.dispose(); client.clear(); });
      expect(client.getQueryData<IssueRecentComments>(commentsKey("ABC-1"))!.comments[0]).toMatchObject({ body: "Newer from the server 0" });
    });

    it("is replaced, not merged, by its first refresh: a comment deleted on the server disappears", async () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      // comment-1-1 was deleted while the browser was closed.
      const current = { ...recentComments(1), comments: recentComments(1).comments.filter((comment) => comment.id !== "comment-1-1") };
      api.recentComments.mockResolvedValue(current);
      api.listComments.mockResolvedValue([]);
      const refreshed = await client.fetchQuery({ ...getIssueRecentCommentsQueryOptions(client, "ABC-1"), queryFn: ({ signal }) => getIssueRecentCommentsQueryOptions(client, "ABC-1").queryFn({ signal }) });
      expect(refreshed.comments.map((comment) => comment.id)).toEqual(["comment-1-0", "comment-1-2"]);
    });

    it("replaces restored activity with its first refresh", async () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      api.recentForIssue.mockResolvedValue([{ id: "event-current" }]);
      await expect(fetchRecentIssueActivity(client, "ABC-1")).resolves.toEqual([{ id: "event-current" }]);
    });

    it("is replaced by the bootstrap when it arrives", async () => {
      const storage = savedPage((client) => { openTask(client, 1); });
      const { client } = page(storage);
      const fresh = recentComments(1, 1, "From the bootstrap");
      const item = {
        ref: "ABC-1", issue: { ...task(1), title: "Current" } as unknown as Issue, recentComments: fresh, commentInputFacts: [],
        recentActivity: [{ id: "event-new" }], recentRuns: [], interactions: [], attachments: [], liveRuns: [], activeRun: null,
      } as unknown as ChatBootstrapItem;
      (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: "ABC-1", startedAt: Date.now(), promise: Promise.resolve(item) };
      await startIssueChatBootstrap(client, COMPANY, "ABC-1", [task(1).id]);
      expect(client.getQueryData<IssueRecentComments>(commentsKey("ABC-1"))!.comments[0]).toMatchObject({ body: "From the bootstrap 0" });
      expect(client.getQueryData(recentIssueActivityQueryKey("ABC-1"))).toEqual([{ id: "event-new" }]);
      expect(isRestoredSavedRead(client, commentsKey("ABC-1"))).toBe(false);
    });
  });
});
