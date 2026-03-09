import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const repoRoot = path.resolve(__dirname, "../../..");
const uiDistDir = path.join(repoRoot, "ui", "dist");
const uiIndexPath = path.join(uiDistDir, "index.html");
const uiIndexHtml = "<!doctype html><html><body>paperclip-spa</body></html>";

const storageService = {
  provider: "local" as const,
  async putFile() {
    throw new Error("not implemented in test");
  },
  async getObject() {
    throw new Error("not implemented in test");
  },
  async headObject() {
    return { exists: false };
  },
  async deleteObject() {
    throw new Error("not implemented in test");
  },
};

beforeAll(() => {
  fs.mkdirSync(uiDistDir, { recursive: true });
  fs.writeFileSync(uiIndexPath, uiIndexHtml, "utf8");
});

afterAll(() => {
  fs.rmSync(uiDistDir, { recursive: true, force: true });
});

describe("SPA fallback", () => {
  it("serves index.html for company-prefixed deep links without intercepting API 404s", async () => {
    const app = await createApp({} as any, {
      uiMode: "static",
      storageService,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const dashboard = await request(app).get("/LAV/dashboard");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers["content-type"]).toContain("text/html");
    expect(dashboard.text).toContain("paperclip-spa");

    const settings = await request(app).get("/LAV/company/settings");
    expect(settings.status).toBe(200);
    expect(settings.headers["content-type"]).toContain("text/html");
    expect(settings.text).toContain("paperclip-spa");

    const apiMissing = await request(app).get("/api/not-found");
    expect(apiMissing.status).toBe(404);
    expect(apiMissing.body).toEqual({ error: "API route not found" });
  });

  it("serves index.html for invite and board-claim paths", async () => {
    const app = await createApp({} as any, {
      uiMode: "static",
      storageService,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
    });

    const invitePage = await request(app).get("/invite/test-token");
    expect(invitePage.status).toBe(200);
    expect(invitePage.headers["content-type"]).toContain("text/html");
    expect(invitePage.text).toContain("paperclip-spa");

    const boardClaimPage = await request(app).get("/board-claim/test-token?code=123456");
    expect(boardClaimPage.status).toBe(200);
    expect(boardClaimPage.headers["content-type"]).toContain("text/html");
    expect(boardClaimPage.text).toContain("paperclip-spa");
  });
});
