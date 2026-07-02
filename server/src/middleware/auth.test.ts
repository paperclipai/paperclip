import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "./auth.js";

// Fake db returning an empty result for every SELECT chain used by
// actorMiddleware. The chained calls (`.select().from().where().then(fn)`)
// and (`.update().set().where()`) both resolve to `[]` / `undefined`.
function createEmptyDb(): Db {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.set = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
  const db = {
    select: () => chain,
    update: () => chain,
  } as unknown as Db;
  return db;
}

function fakeReq(headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    header: (name: string) => lower[name.toLowerCase()],
    method: "POST",
    originalUrl: "/api/companies/x/issues/y/comments",
  } as unknown as Request;
}

function fakeRes() {
  const state: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

const LOCAL_TRUSTED = { deploymentMode: "local_trusted" as const };

describe("actorMiddleware — invalid Bearer paths return 401 (no silent local-board fallthrough)", () => {
  it("returns 401 for an empty token after `Bearer `", async () => {
    const db = createEmptyDb();
    const middleware = actorMiddleware(db, LOCAL_TRUSTED);
    const { res, state } = fakeRes();
    const next = vi.fn() as NextFunction;
    await middleware(fakeReq({ authorization: "Bearer   " }), res, next);
    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({ error: "Unauthorized", reason: "invalid_or_missing_bearer" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a Bearer token with no matching board key, agent key, or valid JWT", async () => {
    const db = createEmptyDb();
    const middleware = actorMiddleware(db, LOCAL_TRUSTED);
    const { res, state } = fakeRes();
    const next = vi.fn() as NextFunction;
    // "notarealjwt" — not a board API key, not a valid agent API key hash,
    // not a well-formed local agent JWT.
    await middleware(fakeReq({ authorization: "Bearer notarealjwt" }), res, next);
    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({ error: "Unauthorized", reason: "invalid_or_missing_bearer" });
    expect(next).not.toHaveBeenCalled();
  });

  it("does NOT 401 when no Authorization header is provided (local_trusted default preserved)", async () => {
    // Deliberately confirms the non-Bearer path (browser console UI in
    // local_trusted mode) still falls through with the local-board actor.
    // A future opt-in strict flag would flip this; keeping the default
    // permissive avoids breaking every existing local paperclipai install.
    const db = createEmptyDb();
    const middleware = actorMiddleware(db, LOCAL_TRUSTED);
    const { res, state } = fakeRes();
    const next = vi.fn() as NextFunction;
    await middleware(fakeReq({}), res, next);
    expect(state.statusCode).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when the Bearer is a syntactically-valid but unsigned JWT-like blob", async () => {
    const db = createEmptyDb();
    const middleware = actorMiddleware(db, LOCAL_TRUSTED);
    const { res, state } = fakeRes();
    const next = vi.fn() as NextFunction;
    // Three-segment header.payload.signature but signature won't verify.
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.deadbeef";
    await middleware(fakeReq({ authorization: `Bearer ${fakeJwt}` }), res, next);
    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({ error: "Unauthorized", reason: "invalid_or_missing_bearer" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 in `authenticated` mode too (no local-board default, but keeps the surface uniform)", async () => {
    const db = createEmptyDb();
    const middleware = actorMiddleware(db, { deploymentMode: "authenticated" });
    const { res, state } = fakeRes();
    const next = vi.fn() as NextFunction;
    await middleware(fakeReq({ authorization: "Bearer notarealjwt" }), res, next);
    expect(state.statusCode).toBe(401);
    expect(state.body).toEqual({ error: "Unauthorized", reason: "invalid_or_missing_bearer" });
    expect(next).not.toHaveBeenCalled();
  });
});
