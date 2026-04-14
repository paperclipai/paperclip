import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

// Mock boardAuthService so actorMiddleware can be instantiated without a real DB.
vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => ({
    findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
    resolveBoardAccess: vi.fn().mockResolvedValue({ user: null, companyIds: [], isInstanceAdmin: false }),
    touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
  }),
}));

const fakeDb = {} as unknown as Db;

function createApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(fakeDb, { deploymentMode }));

  // Echo the resolved actor so tests can inspect it.
  app.all("/test", (req, res) => {
    res.status(200).json({ actor: req.actor });
  });

  return app;
}

describe("local_trusted auth guard for mutating requests", () => {
  it("allows GET without auth header (local-board actor)", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("allows HEAD without auth header", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).head("/test");
    expect(res.status).toBe(200);
  });

  it("allows OPTIONS without auth header", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).options("/test");
    expect(res.status).toBe(200);
  });

  it("rejects POST without auth header with 401", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).post("/test").send({ data: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required for mutating requests");
  });

  it("rejects PATCH without auth header with 401", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).patch("/test").send({ data: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required for mutating requests");
  });

  it("rejects DELETE without auth header with 401", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).delete("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required for mutating requests");
  });

  it("rejects PUT without auth header with 401", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).put("/test").send({ data: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required for mutating requests");
  });

  it("does not reject GET in authenticated mode without auth", async () => {
    const app = createApp("authenticated");
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "none",
      source: "none",
    });
  });

  it("does not reject POST in authenticated mode without auth (actor stays none)", async () => {
    const app = createApp("authenticated");
    const res = await request(app).post("/test").send({ data: "test" });
    // In authenticated mode, no special guard — the route itself handles authz
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "none",
      source: "none",
    });
  });

  it("allows POST with Origin header (board UI) as local_implicit", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .post("/test")
      .set("Origin", "http://localhost:3100")
      .send({ data: "test" });
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("allows PATCH with Origin header (board UI) as local_implicit", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .patch("/test")
      .set("Origin", "http://localhost:3100")
      .send({ data: "test" });
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("allows DELETE with Origin header (board UI) as local_implicit", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .delete("/test")
      .set("Origin", "http://localhost:3100");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("allows PUT with Referer header (board UI) as local_implicit", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .put("/test")
      .set("Referer", "http://localhost:3100/issues")
      .send({ data: "test" });
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("still rejects POST without Origin/Referer (agent curl)", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).post("/test").send({ data: "test" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Authentication required for mutating requests");
  });

  it("attaches run ID to local-board actor on GET requests", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .get("/test")
      .set("X-Paperclip-Run-Id", "run-123");
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      type: "board",
      userId: "local-board",
      runId: "run-123",
    });
  });
});
