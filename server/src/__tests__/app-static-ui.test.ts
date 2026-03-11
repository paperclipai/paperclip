import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("createApp static UI fallback", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.unmock("node:url");
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createStaticUiFixture(pathSegments: string[]) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-ui-"));
    tempRoots.push(tempRoot);

    const packageRoot = path.join(tempRoot, ...pathSegments);
    const uiDist = path.join(packageRoot, "ui-dist");
    fs.mkdirSync(path.join(uiDist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html><html><body>Paperclip</body></html>");
    fs.writeFileSync(path.join(uiDist, "assets", "app.js"), "console.log('ok');");

    return {
      moduleFilePath: path.join(packageRoot, "dist", "app.js"),
    };
  }

  async function createStaticApp(moduleFilePath: string) {
    vi.resetModules();
    vi.doMock("node:url", async () => {
      const actual = await vi.importActual<typeof import("node:url")>("node:url");
      return {
        ...actual,
        fileURLToPath: () => moduleFilePath,
      };
    });

    const { createApp } = await import("../app.js");
    return createApp({} as any, {
      uiMode: "static",
      serverPort: 3100,
      storageService: {} as any,
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: true,
    });
  }

  it("serves index.html for SPA subroutes from dotfile install paths", async () => {
    const fixture = createStaticUiFixture([
      ".npm",
      "_npx",
      "12345",
      "node_modules",
      "@paperclipai",
      "server",
    ]);
    const app = await createStaticApp(fixture.moduleFilePath);

    const spaRes = await request(app).get("/acme/dashboard");
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.text).toContain("Paperclip");
  }, 60_000);

  it("serves static assets from dotfile install paths", async () => {
    const fixture = createStaticUiFixture([
      ".npm",
      "_npx",
      "12345",
      "node_modules",
      "@paperclipai",
      "server",
    ]);
    const app = await createStaticApp(fixture.moduleFilePath);

    const assetRes = await request(app).get("/assets/app.js");
    expect(assetRes.status).toBe(200);
    expect(assetRes.text).toContain("console.log('ok');");
  }, 60_000);

  it("serves index.html for SPA subroutes from regular install paths", async () => {
    const fixture = createStaticUiFixture(["node_modules", "@paperclipai", "server"]);
    const app = await createStaticApp(fixture.moduleFilePath);

    const spaRes = await request(app).get("/acme/dashboard");
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers["content-type"]).toContain("text/html");
    expect(spaRes.text).toContain("Paperclip");
  }, 60_000);
});
