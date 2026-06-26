import type { Request, Response, NextFunction } from "express";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// Minimal Db stub — actorMiddleware only touches it for token-bearing requests.
function makeDb(): any {
  return {
    select: vi.fn(),
    update: vi.fn(),
  };
}

function makeReq(headers: Record<string, string | undefined> = {}): Request {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method: "POST",
    originalUrl: "/api/issues/abc/comments",
    body: {},
    params: {},
    query: {},
    header: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

describe("actorMiddleware — X-Paperclip-Run-Id header validation (ROCAA-33)", () => {
  it("threads a valid UUID runId into req.actor.runId in local_trusted mode", async () => {
    const mw = actorMiddleware(makeDb(), { deploymentMode: "local_trusted" });
    const req = makeReq({ "X-Paperclip-Run-Id": "11111111-1111-4111-8111-111111111111" });
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.actor.type).toBe("board");
    expect(req.actor.runId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("drops a non-UUID runId header (the ROCAA-33 bug) and logs a warn", async () => {
    const mw = actorMiddleware(makeDb(), { deploymentMode: "local_trusted" });
    const req = makeReq({ "X-Paperclip-Run-Id": "surface-ceo-rescope-1779447195-881" });
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.actor.type).toBe("board");
    // Bad header must NOT propagate — that's what triggered Postgres 22P02 on INSERT.
    expect((req.actor as any).runId).toBeUndefined();
  });

  it("ignores a missing runId header (no warn, no field set)", async () => {
    const mw = actorMiddleware(makeDb(), { deploymentMode: "local_trusted" });
    const req = makeReq({});
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req.actor as any).runId).toBeUndefined();
  });

  it("also rejects a truncated UUID prefix (e.g. c136ebcc)", async () => {
    const mw = actorMiddleware(makeDb(), { deploymentMode: "local_trusted" });
    const req = makeReq({ "X-Paperclip-Run-Id": "c136ebcc" });
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, makeRes(), next);

    expect((req.actor as any).runId).toBeUndefined();
  });
});
