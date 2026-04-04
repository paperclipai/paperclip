import { describe, it, expect } from "vitest";
import express from "express";
import helmet from "helmet";
import request from "supertest";

describe("security headers", () => {
  it("sets X-Content-Type-Options header", async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options header", async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
