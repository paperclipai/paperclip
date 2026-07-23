import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";

function createApp() {
  const app = express();
  app.use(express.json());
  // Dummy route that only cares the JSON parser let the request through.
  app.post("/api/echo", (req, res) => {
    res.status(200).json({ received: req.body });
  });
  app.use(errorHandler);
  return app;
}

describe("JSON parse error handler", () => {
  it("returns 400 for truncated JSON body", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send('{"body": "oops"'); // truncated JSON

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toMatch(/Unexpected end|Unexpected token|Expected ',' or '}'/i);
  });

  it("returns 400 for invalid JSON syntax", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send("not json at all");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toMatch(/Unexpected token/i);
  });

  it("returns 400 for JSON with trailing garbage", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send('{"body": "ok"} trailing');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
  });

  it("passes valid JSON through to the route handler", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send('{"body": "valid comment"}');

    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ body: "valid comment" });
  });
});
