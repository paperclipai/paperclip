import express from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

const companyA = "22222222-2222-4222-8222-222222222222";
const companyB = "33333333-3333-4333-8333-333333333333";
const pluginId = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];
let originalNodeEnv: string | undefined;

function createPluginPackage(source = "export default {};\n") {
  const packageRoot = path.join(
    tmpdir(),
    `paperclip-plugin-ui-static-${randomUUID()}`,
  );
  const uiDir = path.join(packageRoot, "dist", "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(path.join(uiDir, "index.js"), source);
  tempDirs.push(packageRoot);
  return packageRoot;
}

function readyPlugin(packageRoot: string) {
  mockRegistry.getById.mockResolvedValue({
    id: pluginId,
    pluginKey: "paperclip.example",
    packageName: "paperclip-plugin-example",
    packagePath: packageRoot,
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      id: "paperclip.example",
      entrypoints: {
        ui: "./dist/ui",
      },
    },
  });
  mockRegistry.getByKey.mockResolvedValue(null);
}

function boardActor(companyIds: string[]) {
  return {
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: false,
    companyIds,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ pluginUiStaticRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugin-ui-static.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(pluginUiStaticRoutes({} as never, { localPluginDir: tmpdir() }));
  app.use(errorHandler);
  return app;
}

describe("plugin UI static route", () => {
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves built UI assets publicly when no company context is requested", async () => {
    readyPlugin(createPluginPackage("export const marker = 'static-bundle';\n"));
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/_plugins/${pluginId}/ui/index.js`);

    expect(res.status).toBe(200);
    expect(res.text).toContain("static-bundle");
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  });

  it("requires authentication before reading company-scoped devUiUrl config", async () => {
    readyPlugin(createPluginPackage());
    const app = await createApp({ type: "none", source: "none" });

    const res = await request(app)
      .get(`/_plugins/${pluginId}/ui/index.js`)
      .query({ companyId: companyA });

    expect(res.status).toBe(401);
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  });

  it("rejects cross-company companyId before reading devUiUrl config", async () => {
    readyPlugin(createPluginPackage());
    const app = await createApp(boardActor([companyA]));

    const res = await request(app)
      .get(`/_plugins/${pluginId}/ui/index.js`)
      .query({ companyId: companyB });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/does not have access/i);
    expect(mockRegistry.getConfig).not.toHaveBeenCalled();
  });

  it("proxies devUiUrl only after company access succeeds", async () => {
    process.env.NODE_ENV = "development";
    readyPlugin(createPluginPackage());
    mockRegistry.getConfig.mockResolvedValue({
      configJson: {
        devUiUrl: "http://localhost:5173/",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("hot bundle", {
      status: 200,
      headers: { "content-type": "application/javascript" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const app = await createApp(boardActor([companyA]));

    const res = await request(app)
      .get(`/_plugins/${pluginId}/ui/index.js`)
      .query({ companyId: companyA });

    expect(res.status).toBe(200);
    expect(res.text).toBe("hot bundle");
    expect(mockRegistry.getConfig).toHaveBeenCalledWith(pluginId, companyA);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5173/index.js",
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });
});
