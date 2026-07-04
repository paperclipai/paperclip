import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => ({
    findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
    resolveBoardAccess: vi.fn(),
    touchBoardApiKey: vi.fn(),
  }),
}));

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn().mockReturnValue(null),
}));

vi.mock("../services/principal-access-compatibility.js", () => ({
  ensureHumanRoleDefaultGrants: vi.fn().mockResolvedValue(undefined),
}));

const stubDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
} as any;

function createApp(deploymentMode: "local_trusted" | "authenticated" = "local_trusted") {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(stubDb, { deploymentMode }));
  app.patch("/api/issues/:id", (req, res) => {
    res.status(200).json({ ok: true, runId: req.actor.runId ?? null });
  });
  app.get("/api/ping", (req, res) => {
    res.status(200).json({ ok: true, runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware — X-Paperclip-Run-Id validation (RES-1349)", () => {
  it("rejects a non-UUID run id header with 422 (not 500)", async () => {
    const res = await request(createApp())
      .patch("/api/issues/RES-1347")
      .set("Host", "paperclip.local:3100")
      .set("Origin", "http://paperclip.local:3100")
      .set("X-Paperclip-Run-Id", "not-a-uuid")
      .send({ comment: "x" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: "X-Paperclip-Run-Id must be a UUID" });
  });

  it("rejects a malformed UUID-shaped run id header with 422", async () => {
    const res = await request(createApp())
      .patch("/api/issues/RES-1347")
      .set("Host", "paperclip.local:3100")
      .set("Origin", "http://paperclip.local:3100")
      .set("X-Paperclip-Run-Id", "deadbeef-not-actually-a-uuid")
      .send({ comment: "x" });

    expect(res.status).toBe(422);
  });

  it("accepts a well-formed UUID run id header and forwards the request", async () => {
    const validRunId = "8f1d7a3c-4e2b-4d5a-9a1f-6c2e1b3d4f50";
    const res = await request(createApp())
      .patch("/api/issues/RES-1347")
      .set("Host", "paperclip.local:3100")
      .set("Origin", "http://paperclip.local:3100")
      .set("X-Paperclip-Run-Id", validRunId)
      .send({ comment: "x" });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(validRunId);
  });

  it("treats an empty run id header as absent (no 422, no run id set)", async () => {
    const res = await request(createApp())
      .get("/api/ping")
      .set("X-Paperclip-Run-Id", "");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("allows requests with no run id header at all", async () => {
    const res = await request(createApp()).get("/api/ping");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });
});
