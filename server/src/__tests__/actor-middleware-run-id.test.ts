import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

// In local_trusted mode without an Authorization header the middleware
// resolves the actor without touching the database, so a sentinel stands
// in for the Db handle on this path.
const sentinelDb = {} as never;

function buildApp() {
  const app = express();
  app.use(actorMiddleware(sentinelDb, { deploymentMode: "local_trusted" }));
  app.get("/probe", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware X-Paperclip-Run-Id handling (#5229)", () => {
  it("keeps a well-formed UUID run id", async () => {
    const runId = "11111111-2222-4333-8444-555555555555";
    const res = await request(buildApp()).get("/probe").set("X-Paperclip-Run-Id", runId);
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });

  it("drops a descriptive non-UUID run id instead of forwarding it to UUID columns", async () => {
    const res = await request(buildApp())
      .get("/probe")
      .set("X-Paperclip-Run-Id", "subagent:cleanup-2026-05-04");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("drops a whitespace-only run id", async () => {
    const res = await request(buildApp()).get("/probe").set("X-Paperclip-Run-Id", "   ");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });

  it("leaves the actor run id unset when the header is absent", async () => {
    const res = await request(buildApp()).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body.runId).toBeNull();
  });
});
