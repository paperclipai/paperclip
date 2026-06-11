import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { runJwtMiddleware } from "../middleware/run-jwt.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

describe("runJwtMiddleware", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-run-jwt-secret";
  });
  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    } else {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    }
  });

  function makeApp() {
    const app = express();
    app.get("/probe", runJwtMiddleware(), (req, res) => {
      res.json({ runJwt: req.runJwt ?? null });
    });
    return app;
  }

  it("leaves req.runJwt unset when no Authorization header is present", async () => {
    const res = await request(makeApp()).get("/probe");
    expect(res.status).toBe(200);
    expect(res.body.runJwt).toBeNull();
  });

  it("leaves req.runJwt unset for malformed Bearer tokens", async () => {
    const res = await request(makeApp())
      .get("/probe")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(200);
    expect(res.body.runJwt).toBeNull();
  });

  it("populates req.runJwt with run/company/connectionIds for a valid Bearer", async () => {
    const jwt = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
      { connectionIds: ["conn-a", "conn-b"] },
    );
    expect(jwt).not.toBeNull();
    const res = await request(makeApp())
      .get("/probe")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.runJwt).toEqual({
      runId: "run-1",
      companyId: "company-1",
      connectionIds: ["conn-a", "conn-b"],
    });
  });

  it("does not set req.runJwt when the JWT lacks an oauth.connectionIds claim", async () => {
    const jwt = createLocalAgentJwt(
      "agent-1",
      "company-1",
      "claude_local",
      "run-1",
    );
    expect(jwt).not.toBeNull();
    const res = await request(makeApp())
      .get("/probe")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.runJwt).toBeNull();
  });
});
