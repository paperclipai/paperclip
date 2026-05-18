import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiRateLimitMiddleware, createApiTimeoutMiddleware } from "../middleware/api-edge-protection.js";

describe("api edge protection middleware", () => {
  it("rate limits log endpoints with stricter budget", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(createApiRateLimitMiddleware({
      logLimitPerMinute: 2,
      defaultLimitPerMinute: 4,
    }));
    app.get("/api/heartbeat-runs/:runId/log", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/heartbeat-runs/run-1/log").set("X-Forwarded-For", "203.0.113.12").expect(200);
    await request(app).get("/api/heartbeat-runs/run-1/log").set("X-Forwarded-For", "203.0.113.12").expect(200);
    const blocked = await request(app)
      .get("/api/heartbeat-runs/run-1/log")
      .set("X-Forwarded-For", "203.0.113.12")
      .expect(429);
    expect(blocked.body).toMatchObject({ error: "Rate limit exceeded" });
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("skips rate limiting for localhost", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use(createApiRateLimitMiddleware({
      logLimitPerMinute: 1,
      defaultLimitPerMinute: 1,
    }));
    app.get("/api/heartbeat-runs/:runId/log", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/heartbeat-runs/run-1/log").set("X-Forwarded-For", "127.0.0.1").expect(200);
    await request(app).get("/api/heartbeat-runs/run-1/log").set("X-Forwarded-For", "127.0.0.1").expect(200);
  });

  it("times out non-log API requests with default timeout", async () => {
    const app = express();
    app.use(createApiTimeoutMiddleware({ defaultTimeoutMs: 20, logEndpointTimeoutMs: 80 }));
    app.get("/api/issues/:id", async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const response = await request(app).get("/api/issues/issue-1").expect(503);
    expect(response.body).toEqual({
      error: "Request timeout",
      timeoutMs: 20,
    });
  });
});
