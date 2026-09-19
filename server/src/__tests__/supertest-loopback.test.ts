import express from "express";
import request from "supertest";
import { expect, it } from "vitest";

it("reaches an in-memory Express app through the loopback address", async () => {
  const app = express();
  app.get("/ping", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const response = await request(app)
    .get("/ping")
    .timeout({ response: 5_000, deadline: 8_000 });

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
});
