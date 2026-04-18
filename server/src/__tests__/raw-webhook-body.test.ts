import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRawWebhookBodyParser } from "../middleware/raw-webhook-body.js";
import { errorHandler } from "../middleware/error-handler.js";

function createApp() {
  const app = express();
  app.use("/webhook", createRawWebhookBodyParser());
  app.use(express.json());
  app.post("/webhook", (req, res) => {
    res.json({
      rawBody: ((req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)).toString("utf8"),
      body: req.body ?? null,
    });
  });
  app.use(errorHandler);
  return app;
}

describe("createRawWebhookBodyParser", () => {
  it("preserves raw JSON bytes and parses the payload", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/webhook")
      .set("content-type", "application/json")
      .send('{"hello":"world"}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rawBody: '{"hello":"world"}',
      body: { hello: "world" },
    });
  });

  it("preserves raw bytes for non-JSON webhook payloads", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/webhook")
      .set("content-type", "text/plain")
      .send("hello=world");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rawBody: "hello=world",
      body: null,
    });
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const app = createApp();

    const res = await request(app)
      .post("/webhook")
      .set("content-type", "application/json")
      .send("not-json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON body" });
  });
});
