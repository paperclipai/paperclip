import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opsStatusRoutes } from "../routes/ops-status.js";

function app() {
  const app = express();
  app.use("/ops-status", opsStatusRoutes());
  return app;
}

describe("opsStatusRoutes", () => {
  beforeEach(() => {
    delete process.env.RENDER_API_KEY;
    delete process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.THOMAS_BRIDGE_HEALTH_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RENDER_API_KEY;
    delete process.env.PAPERCLIP_PUBLIC_URL;
    delete process.env.THOMAS_BRIDGE_HEALTH_URL;
  });

  it("returns sanitized warnings when Render credentials are not configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/health") || url.includes("9119/health")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      if (url.includes("/Costs")) {
        return new Response('<script type="module" src="/assets/index-test.js"></script>', { status: 200 });
      }
      return new Response("Write an article Article Work Article Creation", { status: 200 });
    }));

    const res = await request(app()).get("/ops-status").expect(200);

    expect(res.body.status).toBe("unknown");
    expect(res.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "render-paperclip",
        status: "unknown",
        summary: expect.stringContaining("not connected"),
      }),
      expect.objectContaining({
        id: "paperclip-live",
        status: "ok",
      }),
    ]));
    expect(JSON.stringify(res.body)).not.toContain("rnd_");
  });

  it("flags stale Render repo wiring", async () => {
    process.env.RENDER_API_KEY = "rnd_fake_secret_value";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("api.render.com/v1/services/") && !url.includes("deploys")) {
        return Response.json({ repo: "https://github.com/Awhitter/paperclip", branch: "master" });
      }
      if (url.includes("deploys")) {
        return Response.json([{ deploy: { status: "live", commit: { id: "abc123" } } }]);
      }
      if (url.includes("/api/health") || url.includes("9119/health")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      if (url.includes("/Costs")) {
        return new Response('<script type="module" src="/assets/index-test.js"></script>', { status: 200 });
      }
      return new Response("Write an article Article Work Article Creation", { status: 200 });
    }));

    const res = await request(app()).get("/ops-status").expect(200);

    expect(res.body.status).toBe("error");
    expect(res.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "render-paperclip",
        status: "error",
        detail: expect.stringContaining("Awhitter/paperclip"),
      }),
    ]));
    expect(JSON.stringify(res.body)).not.toContain("rnd_fake_secret_value");
  });

  it("redacts URLs and token query strings from failed check details", async () => {
    process.env.RENDER_API_KEY = "rnd_fake_secret_value";
    process.env.THOMAS_BRIDGE_HEALTH_URL = "https://bridge.example.test/health?token=secret-token";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("api.render.com/v1/services/") && !url.includes("deploys")) {
        return Response.json({ repo: "https://github.com/TheThomais/paperclip", branch: "master" });
      }
      if (url.includes("deploys")) {
        return Response.json([{ deploy: { status: "live", commit: { id: "abc123" } } }]);
      }
      if (url.includes("/api/health") || url.includes("9119/health")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      if (url.includes("/Costs")) {
        return new Response('<script type="module" src="/assets/index-test.js"></script>', { status: 200 });
      }
      if (url.includes("/assets/")) {
        return new Response("Write an article Article Work Article Creation", { status: 200 });
      }
      throw new Error(`failed to fetch ${url}`);
    }));

    const res = await request(app()).get("/ops-status").expect(200);

    expect(JSON.stringify(res.body)).not.toContain("secret-token");
    expect(JSON.stringify(res.body)).not.toContain("bridge.example.test");
    expect(JSON.stringify(res.body)).toContain("[url-redacted]");
    delete process.env.THOMAS_BRIDGE_HEALTH_URL;
  });
});
