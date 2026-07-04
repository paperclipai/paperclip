import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  app.post("/api/issues", (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required", actor: req.actor });
      return;
    }
    res.status(201).json({ ok: true, source: req.actor.source });
  });
  app.patch("/api/issues/:id", (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    res.status(200).json({ ok: true });
  });
  app.get("/api/issues", (req, res) => {
    res.status(200).json({ actorType: req.actor.type, source: req.actor.source });
  });
  return app;
}

describe("actorMiddleware — local_trusted impersonation guard (RES-1298)", () => {
  const ORIGINAL_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL;

  beforeEach(() => {
    delete process.env.PAPERCLIP_PUBLIC_URL;
  });

  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) {
      delete process.env.PAPERCLIP_PUBLIC_URL;
    } else {
      process.env.PAPERCLIP_PUBLIC_URL = ORIGINAL_PUBLIC_URL;
    }
  });

  it("RES-1297 regression: board POST with browser Origin matching Host succeeds", async () => {
    // Realistic browser-board request: Host header set by the LAN bind,
    // Origin matches. This is the path that broke during RES-1297.
    const res = await request(createApp())
      .post("/api/issues")
      .set("Host", "paperclip.local:3100")
      .set("Origin", "http://paperclip.local:3100")
      .send({ title: "test" });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("local_implicit");
  });

  it("RES-1297 regression: board POST behind reverse proxy with PAPERCLIP_PUBLIC_URL succeeds", async () => {
    // Future-proof against the reverse-proxy world: Host may not match the
    // public URL; PAPERCLIP_PUBLIC_URL is the source of truth for Origin.
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example.com";
    const res = await request(createApp())
      .post("/api/issues")
      .set("Host", "paperclip-internal.svc.cluster.local")
      .set("X-Forwarded-Host", "paperclip.example.com")
      .set("Origin", "https://paperclip.example.com")
      .send({ title: "test" });
    expect(res.status).toBe(201);
  });

  it("RES-1297 regression: board PATCH with browser Referer (no Origin) succeeds", async () => {
    // Browsers send Origin for cross-origin, but Referer is the
    // belt-and-braces signal we also honour for same-host PATCH flows.
    const res = await request(createApp())
      .patch("/api/issues/abc")
      .set("Host", "paperclip.local:3100")
      .set("Referer", "http://paperclip.local:3100/RES/issues/RES-1")
      .send({ title: "test" });
    expect(res.status).toBe(200);
  });

  it("RES-1295 fix: curl POST with no Bearer, no Origin, no Referer is blocked", async () => {
    // The impersonation case: a local agent shells out via curl with no
    // Authorization header. Without browser Origin/Referer it resolves
    // anonymous and the route's board check rejects.
    const res = await request(createApp())
      .post("/api/issues")
      .set("Host", "paperclip.local:3100")
      .send({ title: "test" });
    expect(res.status).toBe(403);
    expect(res.body.actor.type).toBe("none");
  });

  it("RES-1295 fix: curl POST with hostile actor body field is still blocked", async () => {
    // Request body cannot inject identity. This guards against the most
    // naive impersonation: a payload claiming to be the board.
    const res = await request(createApp())
      .post("/api/issues")
      .set("Host", "paperclip.local:3100")
      .send({ title: "test", actor: "board", source: "local_implicit" });
    expect(res.status).toBe(403);
  });

  it("RES-1295 fix: curl POST with untrusted Origin is blocked", async () => {
    // An off-host Origin (e.g. malicious page on a different LAN host)
    // does not satisfy the trusted-origin check.
    const res = await request(createApp())
      .post("/api/issues")
      .set("Host", "paperclip.local:3100")
      .set("Origin", "http://attacker.example.com")
      .send({ title: "test" });
    expect(res.status).toBe(403);
  });

  it("safe-method GET without Origin still resolves as board (read paths untouched)", async () => {
    // The fix only gates mutating verbs. GETs are still anonymous-board in
    // local_trusted mode so existing browse/login flows work.
    const res = await request(createApp())
      .get("/api/issues")
      .set("Host", "paperclip.local:3100");
    expect(res.status).toBe(200);
    expect(res.body.actorType).toBe("board");
    expect(res.body.source).toBe("local_implicit");
  });

  it("authenticated deployment mode is untouched (no implicit board, no Origin gate)", async () => {
    // Sanity: non-local-trusted deployments should not gain any new behaviour.
    // Without a Bearer token and without a session, the actor is "none" as before.
    const res = await request(createApp("authenticated"))
      .post("/api/issues")
      .set("Host", "paperclip.example.com")
      .set("Origin", "http://paperclip.example.com")
      .send({ title: "test" });
    expect(res.status).toBe(403);
    expect(res.body.actor.type).toBe("none");
    expect(res.body.actor.source).toBe("none");
  });
});
