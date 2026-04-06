import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression test for https://github.com/paperclipai/paperclip/issues/2898
 *
 * Express 5 (path-to-regexp v8+) dropped support for the `*paramName`
 * wildcard syntax used in Express 4. Routes declared with the old syntax
 * silently fail to match, causing every `/api/auth/*` request to fall
 * through and return 404.
 *
 * The correct Express 5 syntax for a named catch-all is `{*paramName}`.
 * These tests verify that the better-auth handler is invoked for both
 * shallow and deep auth sub-paths.
 */
describe("Express 5 /api/auth wildcard route", () => {
  function buildApp() {
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });
    app.all("/api/auth/{*authPath}", handler);
    return { app, handler };
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

  it("invokes the handler for every matched sub-path", async () => {
    const { app, handler } = buildApp();
    await request(app).post("/api/auth/sign-out");
    await request(app).get("/api/auth/session");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
