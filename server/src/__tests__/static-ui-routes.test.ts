import express from "express";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { installStaticUiRoutes } from "../app.ts";

const tempDirs: string[] = [];

function indexHtml(scriptName: string) {
  return `<!doctype html>
<html>
  <head>
    <!-- PAPERCLIP_RUNTIME_BRANDING_START -->
    <!-- PAPERCLIP_RUNTIME_BRANDING_END -->
    <script type="module" src="/assets/${scriptName}"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;
}

async function createUiDist(scriptName: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-static-ui-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "assets"));
  await writeFile(path.join(dir, "index.html"), indexHtml(scriptName), "utf-8");
  return dir;
}

async function writeIndex(uiDist: string, scriptName: string) {
  await writeFile(path.join(uiDist, "index.html"), indexHtml(scriptName), "utf-8");
}

function createApp(uiDist: string) {
  const app = express();
  installStaticUiRoutes(app, uiDist);
  return app;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("static UI routes", () => {
  it("serves the current index.html for root and bookmarked SPA routes", async () => {
    const uiDist = await createUiDist("old.js");
    const app = createApp(uiDist);

    await writeIndex(uiDist, "new.js");

    const authRes = await request(app).get("/auth?next=%2F").set("Accept", "text/html");
    expect(authRes.status).toBe(200);
    expect(authRes.headers["content-type"]).toContain("text/html");
    expect(authRes.text).toContain("/assets/new.js");
    expect(authRes.text).not.toContain("/assets/old.js");

    const rootRes = await request(app).get("/").set("Accept", "text/html");
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers["content-type"]).toContain("text/html");
    expect(rootRes.text).toContain("/assets/new.js");
    expect(rootRes.text).not.toContain("/assets/old.js");
  });

  it("does not serve fallback HTML for missing static assets", async () => {
    const uiDist = await createUiDist("index.js");
    const app = createApp(uiDist);

    const res = await request(app).get("/assets/old-bundle.js").set("Accept", "*/*");

    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<!doctype html>");
    expect(res.text).not.toContain("/assets/index.js");
  });
});
