import express from "express";
import { createServer } from "node:http";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { stableRequestPath } from "../middleware/logger.js";
import { shouldSilenceHttpSuccessLog } from "../middleware/http-log-policy.js";

// Regression test for a bug where noisy-endpoint silencing (health checks,
// dashboard/issues polling, etc.) never actually fired.
//
// Express mounts middleware/routers via `app.use(prefix, router)` by
// temporarily rewriting `req.url` to strip `prefix` for the duration of that
// router's dispatch, restoring it only when a handler calls `next()` to
// unwind back out of the router. A terminal handler that responds directly
// (`res.json()`, the normal case for API routes) never calls `next()`, so
// `req.url` is *never restored* — it stays stripped for the rest of the
// request's lifetime, including inside a `res.on("finish", ...)` listener
// registered before the router ran (exactly how pino-http observes a
// request). `req.originalUrl` is set once and is never touched by router
// mounting, so it's the only field that reliably reflects the full path at
// finish time.
describe("stableRequestPath", () => {
  it("returns originalUrl (not the router-stripped url) once a request handled by a mounted sub-router finishes", async () => {
    const app = express();
    const api = express.Router();
    let observedAtFinish: { url?: string; originalUrl?: string } | undefined;

    api.get("/companies/:id/heartbeat-runs", (req, res) => {
      res.on("finish", () => {
        observedAtFinish = { url: req.url, originalUrl: req.originalUrl };
      });
      res.json({ ok: true });
    });
    app.use("/api", api);

    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected server to listen on an ephemeral TCP port");
      }

      await new Promise<void>((resolve, reject) => {
        const client = request(
          { hostname: "127.0.0.1", port: address.port, path: "/api/companies/abc/heartbeat-runs" },
          (res) => {
            res.resume();
            res.on("end", resolve);
          },
        );
        client.on("error", reject);
        client.end();
      });

      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    expect(observedAtFinish).toBeDefined();
    // The bug, pinned: by finish time, req.url has lost the /api mount prefix.
    expect(observedAtFinish?.url).toBe("/companies/abc/heartbeat-runs");
    expect(observedAtFinish?.originalUrl).toBe("/api/companies/abc/heartbeat-runs");

    // Using the raw (stripped) url, the silencing pattern (which requires a
    // leading /api/) never matches — this was the live bug.
    expect(shouldSilenceHttpSuccessLog("GET", observedAtFinish?.url, 200)).toBe(false);

    // stableRequestPath prefers originalUrl, so silencing works correctly.
    expect(stableRequestPath(observedAtFinish!)).toBe("/api/companies/abc/heartbeat-runs");
    expect(shouldSilenceHttpSuccessLog("GET", stableRequestPath(observedAtFinish!), 200)).toBe(true);
  });

  it("falls back to url when originalUrl is absent", () => {
    expect(stableRequestPath({ url: "/api/health" })).toBe("/api/health");
  });
});
