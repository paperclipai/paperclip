import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

// Minimal Db mock — not called for local_trusted deployments before run-ID validation
const mockDb = {} as unknown as Db;

function createApp() {
  const app = express();
  app.use(actorMiddleware(mockDb, { deploymentMode: "local_trusted" }));
  app.get("/probe", (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe("X-Paperclip-Run-Id header validation", () => {
  const app = createApp();

  it("returns 400 for a non-UUID run-id (the original 500 repro case)", async () => {
    const res = await request(app)
      .get("/probe")
      .set("X-Paperclip-Run-Id", "claude-local-1780081795-78034");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("UUID") });
  });

  it("passes through when run-id is a valid UUID v4", async () => {
    const res = await request(app)
      .get("/probe")
      .set("X-Paperclip-Run-Id", randomUUID());
    expect(res.status).toBe(200);
  });

  it("passes through when run-id header is absent", async () => {
    const res = await request(app).get("/probe");
    expect(res.status).toBe(200);
  });

  it("returns 400 for an empty run-id string", async () => {
    const res = await request(app)
      .get("/probe")
      .set("X-Paperclip-Run-Id", "");
    expect(res.status).toBe(400);
  });

  it("returns 400 for a UUID missing hyphens", async () => {
    const res = await request(app)
      .get("/probe")
      .set("X-Paperclip-Run-Id", "550e8400e29b41d4a716446655440000");
    expect(res.status).toBe(400);
  });
});
