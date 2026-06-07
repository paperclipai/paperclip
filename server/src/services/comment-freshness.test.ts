import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyCache,
  buildStaleCommentCursorBody,
  evaluateCommentFreshness,
  hasSystemBypassHeader,
  readIdempotencyKey,
  readIfMatch,
} from "./comment-freshness.js";

type FakeActor = {
  type: "agent" | "board" | "none";
  source?: string;
  agentId?: string | null;
  userId?: string | null;
};

function fakeRequest(opts: {
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  actor?: FakeActor;
}) {
  const headers = opts.headers ?? {};
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? undefined,
    body: opts.body ?? {},
    actor: opts.actor ?? { type: "agent", source: "agent_jwt", agentId: "agent-1" },
  } as never;
}

describe("readIfMatch", () => {
  it("reads from the If-Match header", () => {
    const req = fakeRequest({ headers: { "if-match": "comment-abc" } });
    expect(readIfMatch(req)).toBe("comment-abc");
  });

  it("strips ETag quoted-envelope", () => {
    const req = fakeRequest({ headers: { "if-match": "\"comment-abc\"" } });
    expect(readIfMatch(req)).toBe("comment-abc");
  });

  it("strips weak-etag prefix", () => {
    const req = fakeRequest({ headers: { "if-match": "W/\"comment-abc\"" } });
    expect(readIfMatch(req)).toBe("comment-abc");
  });

  it("falls back to body.ifMatch when the header is absent", () => {
    const req = fakeRequest({ body: { ifMatch: "comment-xyz" } });
    expect(readIfMatch(req)).toBe("comment-xyz");
  });

  it("returns null when neither header nor body are present", () => {
    const req = fakeRequest({});
    expect(readIfMatch(req)).toBeNull();
  });
});

describe("readIdempotencyKey", () => {
  it("returns trimmed header value", () => {
    expect(readIdempotencyKey(fakeRequest({ headers: { "idempotency-key": "  key-123  " } }))).toBe("key-123");
  });

  it("returns null for missing or empty headers", () => {
    expect(readIdempotencyKey(fakeRequest({}))).toBeNull();
    expect(readIdempotencyKey(fakeRequest({ headers: { "idempotency-key": "" } }))).toBeNull();
  });

  it("rejects keys longer than 256 characters", () => {
    expect(readIdempotencyKey(fakeRequest({ headers: { "idempotency-key": "x".repeat(257) } }))).toBeNull();
  });
});

describe("hasSystemBypassHeader", () => {
  it("honors the bypass header only for local_implicit board actors", () => {
    const ok = fakeRequest({
      headers: { "x-paperclip-system-comment": "1" },
      actor: { type: "board", source: "local_implicit" },
    });
    expect(hasSystemBypassHeader(ok)).toBe(true);
  });

  it("ignores the bypass header for agents (cannot self-bypass)", () => {
    const reqAgent = fakeRequest({
      headers: { "x-paperclip-system-comment": "1" },
      actor: { type: "agent", source: "agent_jwt", agentId: "agent-1" },
    });
    expect(hasSystemBypassHeader(reqAgent)).toBe(false);
  });

  it("ignores the bypass header for board API key actors (not the harness itself)", () => {
    const reqKey = fakeRequest({
      headers: { "x-paperclip-system-comment": "1" },
      actor: { type: "board", source: "board_key", userId: "user-1" },
    });
    expect(hasSystemBypassHeader(reqKey)).toBe(false);
  });

  it("returns false when the header is unset", () => {
    const req = fakeRequest({ actor: { type: "board", source: "local_implicit" } });
    expect(hasSystemBypassHeader(req)).toBe(false);
  });
});

describe("evaluateCommentFreshness", () => {
  const deps = {
    getCommentCursor: vi.fn(),
    listMissedComments: vi.fn(),
  };

  it("returns bypassed when the system header is honored", async () => {
    const req = fakeRequest({
      headers: { "x-paperclip-system-comment": "1" },
      actor: { type: "board", source: "local_implicit" },
    });
    const outcome = await evaluateCommentFreshness(req, "issue-1", deps);
    expect(outcome).toEqual({ status: "bypassed" });
    expect(deps.getCommentCursor).not.toHaveBeenCalled();
  });

  it("returns missing when If-Match is absent", async () => {
    deps.getCommentCursor.mockReset();
    const req = fakeRequest({});
    const outcome = await evaluateCommentFreshness(req, "issue-1", deps);
    expect(outcome.status).toBe("missing");
    expect(deps.getCommentCursor).not.toHaveBeenCalled();
  });

  it("returns fresh when client cursor matches server cursor", async () => {
    deps.getCommentCursor.mockResolvedValueOnce({ latestCommentId: "c-3", totalComments: 3 });
    const req = fakeRequest({ headers: { "if-match": "c-3" } });
    const outcome = await evaluateCommentFreshness(req, "issue-1", deps);
    expect(outcome).toEqual({ status: "fresh", clientCursor: "c-3" });
  });

  it("returns stale with missed comments when client cursor is behind server", async () => {
    deps.getCommentCursor.mockResolvedValueOnce({ latestCommentId: "c-5", totalComments: 5 });
    deps.listMissedComments.mockResolvedValueOnce([
      { id: "c-4", authorType: "user", createdAt: new Date("2026-05-29T00:00:00Z"), body: "wait, I answered already" },
      { id: "c-5", authorType: "user", createdAt: new Date("2026-05-29T00:00:01Z"), body: "Yes, do option B" },
    ]);
    const req = fakeRequest({ headers: { "if-match": "c-3" } });
    const outcome = await evaluateCommentFreshness(req, "issue-1", deps);
    expect(outcome.status).toBe("stale");
    if (outcome.status !== "stale") throw new Error("expected stale");
    expect(outcome.clientCursor).toBe("c-3");
    expect(outcome.serverCursor).toBe("c-5");
    expect(outcome.missedComments).toHaveLength(2);
    expect(outcome.missedComments[0]).toEqual({
      id: "c-4",
      authorType: "user",
      createdAt: "2026-05-29T00:00:00.000Z",
      bodyPreview: "wait, I answered already",
    });
  });

  it("returns stale with empty since when server thread is empty but client posted a non-empty cursor", async () => {
    deps.getCommentCursor.mockResolvedValueOnce({ latestCommentId: null, totalComments: 0 });
    const req = fakeRequest({ headers: { "if-match": "c-1" } });
    const outcome = await evaluateCommentFreshness(req, "issue-1", deps);
    expect(outcome.status).toBe("stale");
    if (outcome.status !== "stale") throw new Error("expected stale");
    expect(outcome.serverCursor).toBeNull();
    expect(outcome.missedComments).toEqual([]);
  });

  it("buildStaleCommentCursorBody returns the documented shape", () => {
    const body = buildStaleCommentCursorBody({
      status: "stale",
      clientCursor: "c-3",
      serverCursor: "c-5",
      missedComments: [
        { id: "c-4", authorType: "user", createdAt: "2026-01-01T00:00:00.000Z", bodyPreview: "hi" },
      ],
    });
    expect(body).toEqual({
      error: "stale_comment_cursor",
      expected: "c-5",
      received: "c-3",
      since: [{ id: "c-4", authorType: "user", createdAt: "2026-01-01T00:00:00.000Z", bodyPreview: "hi" }],
      retryHint: "Refresh, reconcile, retry.",
    });
  });
});

describe("IdempotencyCache", () => {
  it("returns null for unknown keys", () => {
    const cache = new IdempotencyCache();
    expect(cache.get("scope", "actor", "key")).toBeNull();
  });

  it("returns cached response for a known key", () => {
    const cache = new IdempotencyCache();
    cache.put("scope", "actor", "key", 201, { id: "comment-1" });
    expect(cache.get("scope", "actor", "key")).toEqual({ status: 201, body: { id: "comment-1" } });
  });

  it("expires entries after the TTL", () => {
    let now = 1_000_000;
    const cache = new IdempotencyCache(1_000, () => now);
    cache.put("scope", "actor", "key", 200, { ok: true });
    now += 500;
    expect(cache.get("scope", "actor", "key")).not.toBeNull();
    now += 1_000;
    expect(cache.get("scope", "actor", "key")).toBeNull();
  });

  it("scopes by (scope, actor, key)", () => {
    const cache = new IdempotencyCache();
    cache.put("scopeA", "actor-1", "key", 201, { which: "A" });
    cache.put("scopeB", "actor-1", "key", 201, { which: "B" });
    cache.put("scopeA", "actor-2", "key", 201, { which: "C" });
    expect(cache.get("scopeA", "actor-1", "key")?.body).toEqual({ which: "A" });
    expect(cache.get("scopeB", "actor-1", "key")?.body).toEqual({ which: "B" });
    expect(cache.get("scopeA", "actor-2", "key")?.body).toEqual({ which: "C" });
  });
});
