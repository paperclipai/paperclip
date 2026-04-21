import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/2898
 *
 * Express 5 (path-to-regexp v8+) dropped support for the `*paramName`
 * wildcard syntax used in Express 4. Routes declared with the old syntax
 * silently fail to match, causing every `/api/auth/*` request to fall
 * through and return 404.
 *
 * Paperclip mounts the better-auth handler with a regex catch-all so Express
 * does not rewrite the request URL and every auth sub-path reaches the handler.
 */
describe("Express 5 /api/auth wildcard route", () => {
  let createExpressApp: typeof import("express").default;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.doUnmock("express");
    createExpressApp = (await vi.importActual<typeof import("express")>("express")).default;
  });

  function buildApp() {
    const app = createExpressApp();
    let callCount = 0;
    const handler = (_req: Request, res: Response) => {
      callCount += 1;
      res.status(200).json({ ok: true });
    };
    app.all(/^\/api\/auth(?:\/.*)?$/, handler);
    return {
      app,
      getCallCount: () => callCount,
    };
  }

  it("matches a shallow auth sub-path (sign-in/email)", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/auth/sign-in/email");
    expect(res.status).toBe(200);
  });

  it("matches a deep auth sub-path (callback/credentials/sign-in)", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      "/api/auth/callback/credentials/sign-in"
    );
    expect(res.status).toBe(200);
  });

  it("does not match unrelated paths outside /api/auth", async () => {
    // Confirm the route is not over-broad — requests to other API paths
    // must fall through to 404 and not reach the better-auth handler.
    const { app, getCallCount } = buildApp();
    const res = await request(app).get("/api/other/endpoint");
    expect(res.status).toBe(404);
    expect(getCallCount()).toBe(0);
  });

  it("invokes the handler for every matched sub-path", async () => {
    const { app, getCallCount } = buildApp();
    expect((await request(app).post("/api/auth/sign-out")).status).toBe(200);
    expect((await request(app).get("/api/auth/session")).status).toBe(200);
    expect(getCallCount()).toBe(2);
  });
});
