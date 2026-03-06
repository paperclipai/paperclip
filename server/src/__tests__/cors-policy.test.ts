import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createCorsPolicyMiddleware } from "../middleware/cors-policy.js";

function createApp() {
  const app = express();
  app.use(
    createCorsPolicyMiddleware({
      deploymentMode: "authenticated",
      bindHost: "0.0.0.0",
      allowedHostnames: [],
    }),
  );
  app.get("/api/test", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("cors policy middleware", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_CORS_ALLOWED_ORIGINS;
  });

  it("allows same-host origin", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/test")
      .set("Host", "api.example.com")
      .set("Origin", "https://api.example.com")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe("https://api.example.com");
  });

  it("blocks unknown cross-origin", async () => {
    const app = createApp();
    const response = await request(app)
      .get("/api/test")
      .set("Host", "api.example.com")
      .set("Origin", "https://evil.example")
      .expect(403);

    expect(response.body.error).toBe("CORS origin denied");
  });

  it("allows configured explicit origin", async () => {
    process.env.PAPERCLIP_CORS_ALLOWED_ORIGINS = "https://app.example.com";
    const app = createApp();
    const response = await request(app)
      .get("/api/test")
      .set("Host", "api.example.com")
      .set("Origin", "https://app.example.com")
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  });
});
