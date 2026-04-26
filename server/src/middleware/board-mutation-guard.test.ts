import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { boardMutationGuard } from "./board-mutation-guard.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Helper to build a minimal mock Express Request
function makeReq(overrides: {
  method?: string;
  actor?: { type: string; source?: string };
  headers?: Record<string, string | undefined>;
}): Request {
  const headers = overrides.headers ?? {};
  return {
    method: overrides.method ?? "POST",
    actor: overrides.actor ?? { type: "board", source: "session" },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

function makeNext() {
  return vi.fn();
}

// ============================================================================
// boardMutationGuard — safe HTTP methods always pass through
// ============================================================================

describe("boardMutationGuard — safe methods", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("calls next() for %s method", (method) => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({ method, actor: { type: "board", source: "session" } }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() for lowercase 'get' method", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(makeReq({ method: "get", actor: { type: "board", source: "session" } }), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// boardMutationGuard — non-board actors always pass through
// ============================================================================

describe("boardMutationGuard — non-board actors", () => {
  it("calls next() when actor type is 'agent'", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(makeReq({ method: "POST", actor: { type: "agent" } }), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when actor type is 'system'", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(makeReq({ method: "DELETE", actor: { type: "system" } }), makeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// boardMutationGuard — board actor with trusted source
// ============================================================================

describe("boardMutationGuard — board actor with trusted source", () => {
  it("calls next() when source is 'local_implicit'", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({ method: "POST", actor: { type: "board", source: "local_implicit" } }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when source is 'board_key'", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({ method: "PATCH", actor: { type: "board", source: "board_key" } }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// boardMutationGuard — board session actor, origin/referer checks
// ============================================================================

describe("boardMutationGuard — board session with trusted origin", () => {
  it("calls next() when origin matches default dev origin (localhost:3100)", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: { origin: "http://localhost:3100" },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when origin matches default dev origin (127.0.0.1:3100)", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: { origin: "http://127.0.0.1:3100" },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when origin matches host header", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: { origin: "http://myhost:8080", host: "myhost:8080" },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when origin matches x-forwarded-host", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: {
          origin: "https://proxy.example.com",
          "x-forwarded-host": "proxy.example.com",
        },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when referer matches a trusted origin", () => {
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "DELETE",
        actor: { type: "board", source: "session" },
        headers: { referer: "http://localhost:3100/dashboard" },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() when origin matches PAPERCLIP_PUBLIC_URL", () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://paperclip.example.com");
    const middleware = boardMutationGuard();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: { origin: "https://paperclip.example.com" },
      }),
      makeRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// boardMutationGuard — board session actor, untrusted origin
// ============================================================================

describe("boardMutationGuard — board session with untrusted origin", () => {
  it("returns 403 when origin does not match any trusted source", () => {
    const middleware = boardMutationGuard();
    const res = makeRes();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: { origin: "https://evil.attacker.com" },
      }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when no origin or referer is present", () => {
    const middleware = boardMutationGuard();
    const res = makeRes();
    const next = makeNext();
    middleware(
      makeReq({
        method: "POST",
        actor: { type: "board", source: "session" },
        headers: {},
      }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("does not call next() on 403 response", () => {
    const middleware = boardMutationGuard();
    const res = makeRes();
    const next = makeNext();
    middleware(
      makeReq({ method: "PUT", actor: { type: "board", source: "session" }, headers: {} }),
      res,
      next,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("includes an error message in the 403 response body", () => {
    const middleware = boardMutationGuard();
    const jsonFn = vi.fn();
    const res = { status: vi.fn().mockReturnValue({ json: jsonFn }) } as unknown as Response;
    const next = makeNext();
    middleware(
      makeReq({ method: "POST", actor: { type: "board", source: "session" }, headers: {} }),
      res,
      next,
    );
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});
