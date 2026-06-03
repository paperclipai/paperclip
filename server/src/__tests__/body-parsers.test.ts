// Tests for registerBodyParsers — the shared body-parser stack mounted by
// createApp on BOTH the API tier and the worker tier. The stack must:
//   1. parse application/json into req.body AND capture req.rawBody (existing)
//   2. parse application/x-www-form-urlencoded into req.body AND capture
//      req.rawBody (NEW — Slack interactivity is form-encoded; the handler
//      reads req.body.payload, and signature verification needs the raw bytes)
//   3. capture req.rawBody for ANY other content-type via a raw catch-all
//      (NEW — so a future webhook content-type can never silently re-break
//      HMAC verification by falling through with no captured rawBody)
//
// rawBody fidelity is load-bearing: the API->worker proxy forwards req.rawBody
// verbatim so the provider's HMAC signature still matches downstream.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { registerBodyParsers } from "../http/body-parsers.js";

/** App that mounts only the body parsers + an echo route exposing what was parsed. */
function buildParserApp() {
  const app = express();
  registerBodyParsers(app);
  app.post("/echo", (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    res.json({
      body: req.body,
      rawBody: rawBody ? rawBody.toString("utf8") : null,
      rawBodyIsBuffer: Buffer.isBuffer(rawBody),
    });
  });
  return app;
}

describe("registerBodyParsers", () => {
  it("parses application/json into req.body and captures req.rawBody", async () => {
    const app = buildParserApp();
    const raw = JSON.stringify({ hello: "world" });

    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/json")
      .send(raw);

    expect(res.body.body).toEqual({ hello: "world" });
    expect(res.body.rawBody).toBe(raw);
  });

  it("parses application/x-www-form-urlencoded into req.body.payload and captures the exact raw bytes", async () => {
    const app = buildParserApp();
    // Slack interactivity shape: a single urlencoded `payload=` field.
    const raw =
      "payload=%7B%22type%22%3A%22block_actions%22%2C%22actions%22%3A%5B%5D%7D";

    const res = await request(app)
      .post("/echo")
      .set("content-type", "application/x-www-form-urlencoded")
      .send(raw);

    // The handler reads req.body.payload then JSON.parses it.
    expect(res.body.body).toEqual({
      payload: '{"type":"block_actions","actions":[]}',
    });
    // The proxy forwards these exact bytes for HMAC verification.
    expect(res.body.rawBody).toBe(raw);
  });

  it("captures req.rawBody for an unmatched content-type via the raw catch-all", async () => {
    const app = buildParserApp();
    const raw = "neither-json-nor-form";

    const res = await request(app)
      .post("/echo")
      .set("content-type", "text/plain")
      .send(raw);

    // The catch-all guarantees rawBody is present regardless of content-type,
    // so signature verification can never silently break for a new webhook
    // content-type. req.body becomes a Buffer (no parsed object expected here).
    expect(res.body.rawBody).toBe(raw);
    expect(res.body.rawBodyIsBuffer).toBe(true);
  });
});
