import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { registerBrandStaticRoute } from "../app.js";

// The deployer (e.g. the operator) mounts a brand directory and sets
// PAPERCLIP_BRAND_DIR; applyUiBranding injects <link href="/branding/brand.css">.
// The server must actually serve that directory — falling through to the SPA
// HTML shell returns text/html, which the browser refuses as a stylesheet.

const brandDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-brand-"));
fs.writeFileSync(path.join(brandDir, "brand.css"), ":root { --primary: 24 90% 50%; }\n");

afterAll(() => {
  fs.rmSync(brandDir, { recursive: true, force: true });
});

function appWithSpaFallback(env: NodeJS.ProcessEnv) {
  const app = express();
  registerBrandStaticRoute(app, env);
  // Stand-in for the SPA fallback that serves the HTML shell for everything.
  app.get(/.*/, (_req, res) => {
    res.status(200).set("Content-Type", "text/html").end("<!doctype html>shell");
  });
  return app;
}

describe("registerBrandStaticRoute", () => {
  it("serves brand.css as text/css when PAPERCLIP_BRAND_DIR is set", async () => {
    const app = appWithSpaFallback({ PAPERCLIP_BRAND_DIR: brandDir });
    const res = await request(app).get("/branding/brand.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/css");
    expect(res.text).toContain("--primary");
  });

  it("404s a missing brand asset instead of serving the HTML shell", async () => {
    const app = appWithSpaFallback({ PAPERCLIP_BRAND_DIR: brandDir });
    const res = await request(app).get("/branding/missing.css");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"] ?? "").not.toContain("text/html");
  });

  it("registers nothing when no brand dir is configured (default unchanged)", async () => {
    const app = appWithSpaFallback({});
    const res = await request(app).get("/branding/brand.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
