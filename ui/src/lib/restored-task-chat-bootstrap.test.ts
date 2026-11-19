// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import type { Issue, IssueDocument, IssueRecentComments } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EARLY_CHAT_BOOTSTRAP_GLOBAL } from "./issue-detail-preload-events";
import {
  adoptHardLoadChatBootstrap,
  readFromIssueChatBootstrap,
  resetIssueChatBootstrapsForTest,
  startIssueChatBootstrap,
  type ChatBootstrapItem,
} from "./issue-chat-bootstrap";
import { recentIssueActivityQueryKey } from "./issue-chat-history-queries";
import { getIssueCoreQueryOptions } from "./issueDetailCache";
import { isRestoredSavedRead, startPersistedQueryCache } from "./persisted-query-cache";
import { queryKeys } from "./queryKeys";

// A hard load of a task that the saved read cache remembers: the task's core
// fields are restored (and shown at once), its chat history is not saved, and
// the page's chat bootstrap revalidates both.

const api = vi.hoisted(() => ({ chatBootstrap: vi.fn(), getCore: vi.fn(), getSession: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { chatBootstrap: api.chatBootstrap, getCore: api.getCore } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.getSession } }));

class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const TASK_ID = "00000000-0000-4000-8000-000000000007";
const REF = "ABC-7";
const coreKey = (ref: string) => [...queryKeys.issues.detail(ref), "core"];
const savedTask = { id: TASK_ID, identifier: REF, companyId: "company-one", title: "Saved title", status: "todo" };
const session = (id: string) => ({ session: { id: `session-${id}`, userId: id }, user: { id, name: id, email: `${id}@example.test`, image: null } });

function answer(overrides: Partial<ChatBootstrapItem> = {}): ChatBootstrapItem {
  const comment = { id: "comment-1", body: "Latest reply", createdAt: "2026-11-14T00:00:00Z" };
  return {
    ref: REF,
    issue: { ...savedTask, title: "Current title" } as unknown as Issue,
    recentComments: { comments: [comment], latestCommentId: comment.id, hasMore: false } as unknown as IssueRecentComments,
    commentInputFacts: [],
    recentActivity: [{ id: "event-1" }] as never,
    recentRuns: [],
    interactions: [],
    attachments: [],
    liveRuns: [],
    activeRun: null,
    ...overrides,
  };
}

const disposers: Array<() => void> = [];
/** A new page whose saved read cache remembers `savedTask` for alice. */
function restoredPage(storage = savedStorage()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handle = startPersistedQueryCache(client, { storage, buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
  disposers.push(() => { handle.dispose(); client.clear(); });
  return { client, handle, storage };
}

function savedStorage() {
  const storage = new MemoryStorage();
  const client = new QueryClient();
  const handle = startPersistedQueryCache(client, { storage, buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
  client.setQueryData(queryKeys.auth.session, session("alice"));
  client.setQueryData(queryKeys.companies.list("alice"), { companies: [{ id: "company-one", name: "Example" }], unauthorized: false });
  for (const ref of [REF, TASK_ID]) client.setQueryData(coreKey(ref), savedTask);
  handle.flush();
  handle.dispose();
  client.clear();
  return storage;
}

/** The fetch a hard load's inline script starts before the app runs. */
function earlyBootstrap(promise: Promise<ChatBootstrapItem | null>) {
  (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL] = { ref: REF, startedAt: Date.now(), promise };
}

/** The page's own revalidation of the restored core task, as `useQuery` runs it. */
function revalidateCore(client: QueryClient, ref = REF) {
  return client.fetchQuery({ ...getIssueCoreQueryOptions(client, ref), queryFn: ({ signal }) => getIssueCoreQueryOptions(client, ref).queryFn({ signal }) });
}

beforeEach(() => {
  resetIssueChatBootstrapsForTest();
  api.chatBootstrap.mockReset();
  api.getCore.mockReset();
  api.getCore.mockImplementation(async () => ({ ...savedTask, title: "Read on its own" }));
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  delete (window as unknown as Record<string, unknown>)[EARLY_CHAT_BOOTSTRAP_GLOBAL];
});

describe("a task restored from the saved read cache", () => {
  it("is shown at once and marked as not yet read in this page", () => {
    const { client } = restoredPage();
    expect(client.getQueryData(coreKey(REF))).toMatchObject({ title: "Saved title" });
    expect(isRestoredSavedRead(client, coreKey(REF))).toBe(true);
    // Chat history is never saved, so the chat opens like a cold one.
    expect(client.getQueryData([...queryKeys.issues.comments(REF), "recent"])).toBeUndefined();
  });

  it("revalidates through the page's bootstrap: one request refreshes the restored task and fills the chat", async () => {
    const { client } = restoredPage();
    let respond!: (item: ChatBootstrapItem) => void;
    earlyBootstrap(new Promise((resolve) => { respond = resolve; }));
    void startIssueChatBootstrap(client, "company-one", REF, [TASK_ID, REF]);
    const core = revalidateCore(client);
    respond(answer());
    await expect(core).resolves.toMatchObject({ title: "Current title" });
    expect(api.getCore).not.toHaveBeenCalled();
    // Every ref the task is known by now holds the current answer, read in this page.
    for (const ref of [REF, TASK_ID]) {
      expect(client.getQueryData(coreKey(ref))).toMatchObject({ title: "Current title" });
      expect(isRestoredSavedRead(client, coreKey(ref))).toBe(false);
      expect(client.getQueryState(coreKey(ref))?.isInvalidated).toBe(false);
    }
    expect(client.getQueryData([...queryKeys.issues.comments(REF), "recent"])).toMatchObject({ latestCommentId: "comment-1" });
  });

  it("lets reads keyed by the restored task's id share the bootstrap while it is loading", async () => {
    const { client } = restoredPage();
    let respond!: (item: ChatBootstrapItem) => void;
    earlyBootstrap(new Promise((resolve) => { respond = resolve; }));
    void startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    const ownRead = vi.fn(async () => null);
    const plan = readFromIssueChatBootstrap<IssueDocument | null | undefined>(client, [...queryKeys.issues.documents(TASK_ID), "plan"], TASK_ID, (item) => item.issue.planDocument, ownRead);
    respond(answer({ issue: { ...answer().issue, planDocument: { key: "plan", body: "# Plan" } } as unknown as Issue }));
    await expect(plan).resolves.toMatchObject({ key: "plan" });
    expect(ownRead).not.toHaveBeenCalled();
  });

  it("is shared with readers that start before the task page mounts, by any ref the task is known by", async () => {
    const { client } = restoredPage();
    let respond!: (item: ChatBootstrapItem) => void;
    earlyBootstrap(new Promise((resolve) => { respond = resolve; }));
    // App start, before any route renders.
    adoptHardLoadChatBootstrap(client);
    const ownRead = vi.fn(async () => []);
    const byId = readFromIssueChatBootstrap(client, queryKeys.issues.liveRuns(TASK_ID), TASK_ID, (item) => item.liveRuns, ownRead);
    const byRef = readFromIssueChatBootstrap(client, queryKeys.issues.liveRuns(REF), REF, (item) => item.liveRuns, ownRead);
    respond(answer({ liveRuns: [{ id: "run-1" }] as never }));
    await expect(byId).resolves.toEqual([{ id: "run-1" }]);
    await expect(byRef).resolves.toEqual([{ id: "run-1" }]);
    expect(ownRead).not.toHaveBeenCalled();
    // The task page's own start reuses the adopted request.
    await startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    expect(api.chatBootstrap).not.toHaveBeenCalled();
  });

  it("reads the task itself when no bootstrap is loading (a stale page refresh)", async () => {
    const { client } = restoredPage();
    await expect(revalidateCore(client)).resolves.toMatchObject({ title: "Read on its own" });
    expect(api.getCore).toHaveBeenCalledOnce();
    expect(isRestoredSavedRead(client, coreKey(REF))).toBe(false);
  });

  it("falls back to its own reads when the bootstrap fails, replacing the restored task", async () => {
    const { client } = restoredPage();
    earlyBootstrap(Promise.resolve(null));
    void startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    await expect(revalidateCore(client)).resolves.toMatchObject({ title: "Read on its own" });
    expect(api.getCore).toHaveBeenCalledOnce();
    expect(client.getQueryData(coreKey(REF))).toMatchObject({ title: "Read on its own" });
  });

  it("uses the fields a partial answer has and reads the missing ones itself", async () => {
    const { client } = restoredPage();
    earlyBootstrap(Promise.resolve(answer({ recentActivity: undefined as never })));
    await startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    expect(client.getQueryData(coreKey(REF))).toMatchObject({ title: "Current title" });
    expect(client.getQueryData(recentIssueActivityQueryKey(REF))).toBeUndefined();
    const ownRead = vi.fn(async () => [{ id: "own-event" }]);
    await expect(readFromIssueChatBootstrap(client, recentIssueActivityQueryKey(REF), REF, (item) => item.recentActivity, ownRead))
      .resolves.toEqual([{ id: "own-event" }]);
    expect(ownRead).toHaveBeenCalledOnce();
  });

  it("removes the restored task when the user can no longer read it", async () => {
    const { client, storage } = restoredPage();
    // An unreadable task is omitted from (or fails) the bootstrap.
    earlyBootstrap(Promise.resolve(null));
    void startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    api.getCore.mockImplementation(async () => { throw new ApiError("Forbidden", 403, null); });
    await expect(revalidateCore(client)).rejects.toThrow("Forbidden");
    for (const ref of [REF, TASK_ID]) expect(client.getQueryData(coreKey(ref))).toBeUndefined();
    expect([...storage.values.values()].join(" ")).not.toContain("Saved title");
  });

  it("never fills another company's task from the bootstrap", async () => {
    const { client } = restoredPage();
    earlyBootstrap(Promise.resolve(answer({ issue: { ...answer().issue, companyId: "company-two" } as unknown as Issue })));
    await startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    expect(client.getQueryData(coreKey(REF))).toMatchObject({ title: "Saved title" });
    expect(client.getQueryData([...queryKeys.issues.comments(REF), "recent"])).toBeUndefined();
    await expect(revalidateCore(client)).resolves.toMatchObject({ title: "Read on its own" });
  });

  it("never uses an answer once another user signs in", async () => {
    const { client } = restoredPage();
    let respond!: (item: ChatBootstrapItem) => void;
    earlyBootstrap(new Promise((resolve) => { respond = resolve; }));
    // The restored session is alice's; the early fetch belongs to her.
    void startIssueChatBootstrap(client, "company-one", REF, [TASK_ID]);
    client.setQueryData(queryKeys.auth.session, session("bob"));
    respond(answer());
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getQueryData([...queryKeys.issues.comments(REF), "recent"])).toBeUndefined();
    expect(client.getQueryData(coreKey(REF))).not.toMatchObject({ title: "Current title" });
  });

  it("is not restored for another user", () => {
    const storage = savedStorage();
    const client = new QueryClient();
    client.setQueryData(queryKeys.auth.session, session("bob"));
    const handle = startPersistedQueryCache(client, { storage, buildId: "build-one", eventTarget: null, debounceMs: 100_000 });
    disposers.push(() => { handle.dispose(); client.clear(); });
    expect(client.getQueryData(coreKey(REF))).toBeUndefined();
    expect(isRestoredSavedRead(client, coreKey(REF))).toBe(false);
  });
});
