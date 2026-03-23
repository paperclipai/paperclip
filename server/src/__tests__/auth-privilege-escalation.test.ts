import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { actorMiddleware } from "../middleware/auth.js";
import type { Db } from "@paperclipai/db";

/**
 * Regression test for GH #1314: in local_trusted mode, an invalid bearer token
 * must NOT inherit the default board actor. Without the fix, expired/invalid agent
 * JWTs would fall through to the local_trusted board default, granting full
 * board-level access (including agent deletion).
 */
describe("auth privilege escalation prevention", () => {
  function createApp(deploymentMode: "local_trusted" | "authenticated") {
    const app = express();
    // Stub DB: all queries return empty results
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([])),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    } as unknown as Db;

    app.use(actorMiddleware(fakeDb, { deploymentMode }));
    app.get("/test", (req, res) => {
      res.json({ actorType: req.actor.type, source: req.actor.source });
    });
    return app;
  }

  it("local_trusted without bearer token keeps board actor", async () => {
    const app = createApp("local_trusted");
    const res = await request(app).get("/test");
    expect(res.body.actorType).toBe("board");
    expect(res.body.source).toBe("local_implicit");
  });

  it("local_trusted with invalid bearer token clears board actor to none", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer invalid-or-expired-token");
    expect(res.body.actorType).toBe("none");
    expect(res.body.source).toBe("none");
  });

  it("local_trusted with empty bearer token keeps board actor", async () => {
    const app = createApp("local_trusted");
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer ");
    expect(res.body.actorType).toBe("board");
    expect(res.body.source).toBe("local_implicit");
  });

  it("authenticated mode with invalid bearer token stays none", async () => {
    const app = createApp("authenticated");
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer invalid-token");
    expect(res.body.actorType).toBe("none");
  });
});
