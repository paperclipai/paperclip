import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { rejectNullBytes } from "../middleware/reject-null-bytes.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(rejectNullBytes);
  app.post("/echo", (req, res) => res.json(req.body));
  return app;
}

describe("rejectNullBytes middleware", () => {
  it("rejects request body containing null bytes in a string", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({ body: "hello\x00world" })
      .expect(400);
    expect(res.body.error).toBe("Request body contains null bytes");
  });

  it("rejects null bytes in nested objects", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({ outer: { inner: "a\x00b" } })
      .expect(400);
    expect(res.body.error).toBe("Request body contains null bytes");
  });

  it("rejects null bytes in array elements", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({ items: ["a\x00b", "cd"] })
      .expect(400);
    expect(res.body.error).toBe("Request body contains null bytes");
  });

  it("passes through clean strings unchanged", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({ body: "no null bytes here" })
      .expect(200);
    expect(res.body.body).toBe("no null bytes here");
  });

  it("preserves non-string values", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({ num: 42, bool: true, nil: null })
      .expect(200);
    expect(res.body).toEqual({ num: 42, bool: true, nil: null });
  });

  it("handles empty body", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/echo")
      .send({})
      .expect(200);
    expect(res.body).toEqual({});
  });
});
