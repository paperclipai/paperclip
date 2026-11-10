import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, detachInflightGets } from "./client";
import {
  TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS,
  readTaskChatBootstrapPreload,
  resetTaskChatBootstrapPreloadForTests,
  takePreloadedGet,
} from "./task-chat-bootstrap-preload";

const ID = "11111111-1111-4111-8111-111111111111";
const REQUESTED_AT = 1_000_000;

function item(overrides: Record<string, unknown> = {}) {
  return {
    ref: "PAP-7",
    issue: { id: ID, identifier: "PAP-7", companyId: "company-1", title: "Task" },
    recentComments: { comments: [], hasMore: false },
    commentInputFacts: [],
    recentActivity: [{ id: "a1" }],
    recentRuns: [],
    interactions: [{ id: "i1" }],
    attachments: [],
    liveRuns: [],
    activeRun: null,
    ...overrides,
  };
}

let clock = REQUESTED_AT;
function install(response: Promise<unknown>, ref = "PAP-7") {
  (globalThis as unknown as Record<string, unknown>).__PAPERCLIP_TASK_CHAT_BOOTSTRAP__ = {
    ref,
    pathname: `/PAP/issues/${ref}`,
    requestedAt: REQUESTED_AT,
    response,
  };
}

const fetchMock = vi.fn();
beforeEach(() => {
  clock = REQUESTED_AT;
  resetTaskChatBootstrapPreloadForTests({ now: () => clock });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__PAPERCLIP_TASK_CHAT_BOOTSTRAP__;
  resetTaskChatBootstrapPreloadForTests();
  vi.unstubAllGlobals();
});

describe("takePreloadedGet", () => {
  it("answers each first-frame path of the URL ref with its field", async () => {
    install(Promise.resolve(item()));
    await expect(takePreloadedGet("/issues/PAP-7?view=core")).resolves.toEqual({ hit: true, value: item().issue });
    await expect(takePreloadedGet("/issues/PAP-7/activity?view=recent")).resolves.toEqual({ hit: true, value: [{ id: "a1" }] });
    await expect(takePreloadedGet("/issues/PAP-7/interactions")).resolves.toEqual({ hit: true, value: [{ id: "i1" }] });
    // `null` is an answer: the task has no active run.
    await expect(takePreloadedGet("/issues/PAP-7/active-run")).resolves.toEqual({ hit: true, value: null });
  });

  it("ignores other paths and other tasks", () => {
    install(Promise.resolve(item()));
    expect(takePreloadedGet("/issues/PAP-7")).toBeNull();
    expect(takePreloadedGet("/issues/PAP-7/activity")).toBeNull();
    expect(takePreloadedGet("/issues/PAP-7/activity?view=comment-inputs&commentIds=c1")).toBeNull();
    expect(takePreloadedGet("/issues/PAP-8/interactions")).toBeNull();
    expect(takePreloadedGet("/issues/PAP-70/interactions")).toBeNull();
  });

  it("answers a path once, so a refetch reaches the server", async () => {
    install(Promise.resolve(item()));
    await expect(takePreloadedGet("/issues/PAP-7/attachments")).resolves.toMatchObject({ hit: true });
    expect(takePreloadedGet("/issues/PAP-7/attachments")).toBeNull();
  });

  it("treats a missing field as unknown", async () => {
    const partial = item();
    delete (partial as Record<string, unknown>).recentRuns;
    install(Promise.resolve(partial));
    await expect(takePreloadedGet("/issues/PAP-7/runs?view=recent")).resolves.toEqual({ hit: false });
  });

  it("misses when the bootstrap failed or answered something else", async () => {
    install(Promise.resolve(null));
    await expect(takePreloadedGet("/issues/PAP-7/interactions")).resolves.toEqual({ hit: false });
    resetTaskChatBootstrapPreloadForTests({ now: () => clock });
    install(Promise.reject(new Error("offline")));
    await expect(takePreloadedGet("/issues/PAP-7/interactions")).resolves.toEqual({ hit: false });
    resetTaskChatBootstrapPreloadForTests({ now: () => clock });
    install(Promise.resolve({ error: "Issue not found" }));
    await expect(takePreloadedGet("/issues/PAP-7/interactions")).resolves.toEqual({ hit: false });
  });

  it("stops answering once the bootstrap is stale", async () => {
    install(Promise.resolve(item()));
    clock = REQUESTED_AT + TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS + 1;
    expect(takePreloadedGet("/issues/PAP-7/interactions")).toBeNull();
  });

  it("misses when the response arrives after the fresh window", async () => {
    let resolve!: (value: unknown) => void;
    install(new Promise((res) => { resolve = res; }));
    const answer = takePreloadedGet("/issues/PAP-7/interactions");
    clock = REQUESTED_AT + TASK_CHAT_BOOTSTRAP_PRELOAD_FRESH_MS + 1;
    resolve(item());
    await expect(answer).resolves.toEqual({ hit: false });
  });

  it("stops waiting for a stalled bootstrap after the wait deadline", async () => {
    resetTaskChatBootstrapPreloadForTests({ now: () => clock, waitMs: 5 });
    install(new Promise(() => {}));
    await expect(takePreloadedGet("/issues/PAP-7/interactions")).resolves.toEqual({ hit: false });
  });

  it("reads the window global once", () => {
    install(Promise.resolve(item()));
    const first = readTaskChatBootstrapPreload();
    expect(first?.ref).toBe("PAP-7");
    expect((globalThis as unknown as Record<string, unknown>).__PAPERCLIP_TASK_CHAT_BOOTSTRAP__).toBeUndefined();
    expect(readTaskChatBootstrapPreload()).toBe(first);
  });
});

describe("API client GETs during the preload", () => {
  it("returns the preloaded field without a request", async () => {
    install(Promise.resolve(item()));
    await expect(api.get("/issues/PAP-7/interactions")).resolves.toEqual([{ id: "i1" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to its own request when the bootstrap cannot answer", async () => {
    install(Promise.resolve(null));
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: "from-server" }] } as unknown as Response);
    await expect(api.get("/issues/PAP-7/interactions")).resolves.toEqual([{ id: "from-server" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/issues/PAP-7/interactions");
  });

  it("does not serve a fresh read or a read after an account change", async () => {
    install(Promise.resolve(item()));
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [] } as unknown as Response);
    await api.get("/issues/PAP-7/live-runs", { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    detachInflightGets();
    await api.get("/issues/PAP-7/attachments");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
