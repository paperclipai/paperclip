import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRateLimitMiddleware } from "../middleware/rate-limit.js";

describe("rate limit middleware", () => {
  it("returns 429 after max requests", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      createRateLimitMiddleware({
        name: "test",
        windowMs: 60_000,
        max: 2,
      }),
    );
    app.get("/api/ping", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/api/ping").expect(200);
    await request(app).get("/api/ping").expect(200);
    const response = await request(app).get("/api/ping").expect(429);
    expect(response.body.error).toBe("Rate limit exceeded");
    expect(response.body.code).toBe("rate_limited");
  });
});
