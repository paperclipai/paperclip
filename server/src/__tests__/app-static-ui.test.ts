import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { mountStaticUi } from "../app.js";

describe("mountStaticUi", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createStaticUiApp(pathSegments: string[]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-ui-"));
    tempRoots.push(tempRoot);

    const uiDist = path.join(tempRoot, ...pathSegments);
    fs.mkdirSync(path.join(uiDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html><html><body>Paperclip</body></html>");
    fs.writeFileSync(path.join(uiDist, "assets", "app.js"), "console.log('ok');");

    const app = express();
    mountStaticUi(app, uiDist);
    return app;
  }

  it("serves index.html for SPA subroutes from dotfile install paths", async () => {
    const app = createStaticUiApp([
      ".npm",
      "_npx",
      "12345",
      "node_modules",
      "@paperclipai",
      "server",
      "ui-dist",
    ]);

    const spaRes = await request(app).get("/acme/dashboard");
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.text).toContain("Paperclip");
  });

  it("serves static assets from dotfile install paths", async () => {
    const app = createStaticUiApp([
      ".npm",
      "_npx",
      "12345",
      "node_modules",
      "@paperclipai",
      "server",
      "ui-dist",
    ]);

    const assetRes = await request(app).get("/assets/app.js");
    expect(assetRes.status).toBe(200);
    expect(assetRes.text).toContain("console.log('ok');");
  });

  it("serves index.html for SPA subroutes from regular install paths", async () => {
    const app = createStaticUiApp(["node_modules", "@paperclipai", "server", "ui-dist"]);

    const spaRes = await request(app).get("/acme/dashboard");
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.text).toContain("Paperclip");
  });
});
