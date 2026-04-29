import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { appendPublicUrl } from "../middleware/append-public-url.js";

describe("appendPublicUrl middleware", () => {
  it("adds publicUrl with trailing slashes normalized to JSON responses", async () => {
    const app = express();
    app.use(appendPublicUrl("https://paperclip.example.com//"));
    app.get("/test", (_req, res) => {
      res.json({ status: "ok" });
    });

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      publicUrl: "https://paperclip.example.com",
    });
  });

  it("emits publicUrl: null when no URL is configured", async () => {
    const app = express();
    app.use(appendPublicUrl(null));
    app.get("/test", (_req, res) => {
      res.json({ status: "ok" });
    });

    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      publicUrl: null,
    });
  });

  it("does not overwrite an existing publicUrl on the body", async () => {
    const app = express();
    app.use(appendPublicUrl("https://override.example.com"));
    app.get("/test", (_req, res) => {
      res.json({ status: "ok", publicUrl: "https://route-set.example.com" });
    });

    const res = await request(app).get("/test");
    expect(res.body.publicUrl).toBe("https://route-set.example.com");
  });

  it("leaves array bodies unchanged", async () => {
    const app = express();
    app.use(appendPublicUrl("https://paperclip.example.com"));
    app.get("/test", (_req, res) => {
      res.json([{ id: 1 }, { id: 2 }]);
    });

    const res = await request(app).get("/test");
    expect(res.body).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("leaves null bodies unchanged", async () => {
    const app = express();
    app.use(appendPublicUrl("https://paperclip.example.com"));
    app.get("/test", (_req, res) => {
      res.json(null);
    });

    const res = await request(app).get("/test");
    expect(res.body).toBe(null);
  });
});
