import express from "express";
import { createServer, type Server } from "node:http";
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
describe.sequential("Express 5 /api/auth wildcard route", () => {
  async function buildFixture() {
    const app = express();
    const handler = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(200).json({ ok: true });
    });
    app.all("/api/auth/{*authPath}", handler);
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    return { agent: request(server), close: () => closeServer(server), handler };
  }

  async function closeServer(server: Server) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function withFixture<T>(
    run: (fixture: Awaited<ReturnType<typeof buildFixture>>) => Promise<T>,
  ) {
    const fixture = await buildFixture();
    try {
      return await run(fixture);
    } finally {
      await fixture.close();
    }
  }

  it.sequential("matches a shallow auth sub-path (sign-in/email)", async () => {
    const res = await withFixture(({ agent }) => agent.post("/api/auth/sign-in/email"));
    expect(res.status).toBe(200);
  });

  it.sequential("matches a deep auth sub-path (callback/credentials/sign-in)", async () => {
    const res = await withFixture(({ agent }) => agent.get(
      "/api/auth/callback/credentials/sign-in"
    ));
    expect(res.status).toBe(200);
  });

  it.sequential("does not match unrelated paths outside /api/auth", async () => {
    // Confirm the route is not over-broad — requests to other API paths
    // must fall through to 404 and not reach the better-auth handler.
    const { res, handler } = await withFixture(async ({ agent, handler }) => ({
      res: await agent.get("/api/other/endpoint"),
      handler,
    }));
    expect(res.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it.sequential("invokes the handler for every matched sub-path", async () => {
    await withFixture(async ({ agent, handler }) => {
      await agent.post("/api/auth/sign-out");
      await agent.get("/api/auth/session");
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });
});
