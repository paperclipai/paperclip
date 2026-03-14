import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { actorMiddleware } from "../middleware/auth.js";

// Minimal mock for the database layer
function createMockDb(opts?: {
  apiKeyRows?: any[];
  agentRows?: any[];
  roleRows?: any[];
  membershipRows?: any[];
}) {
  const { apiKeyRows = [], agentRows = [], roleRows = [], membershipRows = [] } = opts ?? {};

  const mockChain = (rows: any[]) => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      set: () => chain,
      then: (fn: any) => Promise.resolve(fn(rows)),
    };
    return chain;
  };

  return {
    select: () => mockChain(apiKeyRows),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  } as any;
}

function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode }));
  app.get("/test", (req, res) => {
    res.json({ actor: req.actor });
  });
  return app;
}

describe("actorMiddleware fail-closed behavior", () => {
  it("passes through without auth header (unauthenticated access for public endpoints)", async () => {
    const db = createMockDb();
    const app = createApp(db);
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("none");
  });

  it("returns 401 when bearer token is present but invalid", async () => {
    const db = createMockDb({ apiKeyRows: [] });
    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer some-bad-token");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 401 when bearer token is invalid (no matching key, no valid JWT)", async () => {
    const db = createMockDb({ apiKeyRows: [] });
    const app = createApp(db);
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer invalid-token-here");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("allows local_trusted mode to pass through as board", async () => {
    const db = createMockDb();
    const app = createApp(db, "local_trusted");
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body.actor.type).toBe("board");
    expect(res.body.actor.source).toBe("local_implicit");
  });
});
