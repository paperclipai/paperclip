import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimiters } from "../middleware/rate-limit.js";

describe("rate limiting", () => {
  it("returns 429 after auth limit exceeded", async () => {
    const app = express();
    const { authLimiter } = createRateLimiters({ authMax: 2, writeMax: 100, readMax: 300 });
    app.use("/api/auth", authLimiter);
    app.get("/api/auth/test", (_req, res) => res.json({ ok: true }));

    const agent = request(app);
    await agent.get("/api/auth/test").expect(200);
    await agent.get("/api/auth/test").expect(200);
    await agent.get("/api/auth/test").expect(429);
  });

  it("separates write and read limits", async () => {
    const app = express();
    const { writeLimiter, readLimiter } = createRateLimiters({ authMax: 10, writeMax: 1, readMax: 100 });
    app.use((req, res, next) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        writeLimiter(req, res, next);
      } else {
        readLimiter(req, res, next);
      }
    });
    app.post("/test", (_req, res) => res.json({ ok: true }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const agent = request(app);
    await agent.post("/test").expect(200);
    await agent.post("/test").expect(429);
    await agent.get("/test").expect(200);
  });
});
