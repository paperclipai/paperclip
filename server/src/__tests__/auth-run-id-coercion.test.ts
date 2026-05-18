import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { actorMiddleware, coerceRunId } from "../middleware/auth.js";

function createDb() {
  return {} as any;
}

function createApp() {
  const app = express();
  app.use(
    actorMiddleware(createDb(), {
      deploymentMode: "local_trusted",
    }),
  );
  app.get("/actor", (req, res) => {
    res.json({ runId: req.actor.runId ?? null });
  });
  return app;
}

describe("actorMiddleware X-Paperclip-Run-Id coercion (header path)", () => {
  it("passes through a valid UUID run id unchanged", async () => {
    const app = createApp();
    const validUuid = "11111111-2222-4333-8444-555555555555";

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", validUuid);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: validUuid });
  });

  it("coerces a malformed run id header to null so downstream UUID columns receive null instead of 500ing", async () => {
    const app = createApp();
    // Real example seen in NOY-6892 forensics — agent constructed a slug-style id.
    const malformed = "noy6809-monitor-1778938148";

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", malformed);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: null });
  });

  it("treats a missing run id header as null", async () => {
    const app = createApp();

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: null });
  });

  it("coerces an empty run id header to null", async () => {
    const app = createApp();

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", "");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: null });
  });
});

// Direct unit-test coverage of the JWT-claim branch. Building a fully-signed
// agent JWT + stubbing the DB just to exercise the same helper as the header
// path would add a lot of moving parts; the helper itself is the contract.
describe("coerceRunId (JWT-claim path)", () => {
  const fakeReq = { method: "POST", originalUrl: "/api/issues/abc/comments" };

  it("passes through a valid UUID claims.run_id unchanged", () => {
    const validUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(coerceRunId(validUuid, "jwt", fakeReq)).toBe(validUuid);
  });

  it("coerces a malformed claims.run_id to undefined", () => {
    expect(coerceRunId("noy6809-monitor-1778938148", "jwt", fakeReq)).toBeUndefined();
  });

  it("treats a missing or empty claims.run_id as undefined", () => {
    expect(coerceRunId(undefined, "jwt", fakeReq)).toBeUndefined();
    expect(coerceRunId(null, "jwt", fakeReq)).toBeUndefined();
    expect(coerceRunId("", "jwt", fakeReq)).toBeUndefined();
  });
});
