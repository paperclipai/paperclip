import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";

function createApp() {
  const app = express();
  app.use(actorMiddleware({} as any, { deploymentMode: "local_trusted" }));
  app.get("/whoami", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("actorMiddleware run id handling", () => {
  it("ignores malformed x-paperclip-run-id headers", async () => {
    const res = await request(createApp())
      .get("/whoami")
      .set("X-Paperclip-Run-Id", "trust-audit-001");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    expect(res.body).not.toHaveProperty("runId");
  });

  it("preserves UUID run ids from x-paperclip-run-id headers", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const res = await request(createApp())
      .get("/whoami")
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
  });
});
