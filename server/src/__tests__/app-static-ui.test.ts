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

  it("serves SPA fallback from install paths that contain dotfile segments", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-ui-"));
    tempRoots.push(tempRoot);

    const uiDist = path.join(
      tempRoot,
      ".npm",
      "_npx",
      "12345",
      "node_modules",
      "@paperclipai",
      "server",
      "ui-dist",
    );
    fs.mkdirSync(path.join(uiDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html><html><body>Paperclip</body></html>");
    fs.writeFileSync(path.join(uiDist, "assets", "app.js"), "console.log('ok');");

    const app = express();
    mountStaticUi(app, uiDist);

    const spaRes = await request(app).get("/acme/dashboard");
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.text).toContain("Paperclip");

    const assetRes = await request(app).get("/assets/app.js");
    expect(assetRes.status).toBe(200);
    expect(assetRes.text).toContain("console.log('ok');");
  });
});
