import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

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
    let callCount = 0;
    const handler = (_req: express.Request, res: express.Response) => {
      callCount += 1;
      res.status(200).json({ ok: true });
    };
    app.all("/api/auth/{*authPath}", handler);
    return {
      app,
      getCallCount: () => callCount,
    };
  }

  it("matches auth sub-paths without matching unrelated API paths", async () => {
    const { app, getCallCount } = buildApp();

    await expect(request(app).post("/api/auth/sign-in/email")).resolves.toMatchObject({
      status: 200,
    });
    await expect(request(app).get("/api/auth/callback/credentials/sign-in")).resolves.toMatchObject({
      status: 200,
    });
    expect(getCallCount()).toBe(2);

    await expect(request(app).get("/api/other/endpoint")).resolves.toMatchObject({
      status: 404,
    });
    expect(getCallCount()).toBe(2);

    await expect(request(app).post("/api/auth/sign-out")).resolves.toMatchObject({
      status: 200,
    });
    await expect(request(app).get("/api/auth/session")).resolves.toMatchObject({
      status: 200,
    });
    expect(getCallCount()).toBe(4);
  });
});
