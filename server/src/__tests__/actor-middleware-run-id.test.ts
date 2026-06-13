import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// In local_trusted mode without an Authorization header, actorMiddleware
// short-circuits before touching the DB. We can pass a sentinel and trust the
// middleware never calls into it on this path.
const sentinelDb = {} as never;

function buildApp() {
  const app = express();
  app.use(actorMiddleware(sentinelDb, { deploymentMode: "local_trusted" }));
  app.get("/probe", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware — X-Paperclip-Run-Id sanitization (#5229)", () => {
  it("propagates a valid v4 UUID run-id", async () => {
    const validUuid = "11111111-2222-4333-8444-555555555555";
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", validUuid);
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(validUuid);
  });

  it("drops a non-UUID run-id instead of forwarding it to UUID-typed FK columns", async () => {
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "subagent:cleanup-2026-05-04");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("drops an empty run-id", async () => {
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "   ");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("drops a UUID-shaped value with the wrong version digit", async () => {
    // Right-shape but version 6 — Postgres uuid type is permissive about version,
    // but we keep parity with isUuidLike (RFC 4122 v1-v5).
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "11111111-2222-6333-8444-555555555555");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });
});
