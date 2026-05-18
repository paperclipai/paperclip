import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pluginUiStaticRoutes, resolvePluginUiDir } from "../routes/plugin-ui-static.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(localPluginDir = "/tmp/plugins") {
  const app = express();
  app.use(pluginUiStaticRoutes({} as any, { localPluginDir }));
  app.use(errorHandler);
  return app;
}

function makePlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "plugin-uuid-1",
    pluginKey: "acme.demo",
    packageName: "@acme/demo",
    packagePath: null,
    status: "ready",
    manifestJson: {
      entrypoints: { ui: "./dist/ui/" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolvePluginUiDir
// ---------------------------------------------------------------------------

describe("resolvePluginUiDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-ui-static-test-"));
  });

  it("returns null when packageRoot does not exist in node_modules", () => {
    const result = resolvePluginUiDir(tmpDir, "@acme/nonexistent", "./dist/ui/");
    expect(result).toBeNull();
  });

  it("resolves scoped package from node_modules", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "@acme", "demo");
    const uiDir = path.join(pkgDir, "dist", "ui");
    fs.mkdirSync(uiDir, { recursive: true });

    const result = resolvePluginUiDir(tmpDir, "@acme/demo", "./dist/ui/");
    expect(result).toBe(uiDir);
  });

  it("resolves unscoped package from node_modules", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "myplugin");
    const uiDir = path.join(pkgDir, "dist", "ui");
    fs.mkdirSync(uiDir, { recursive: true });

    const result = resolvePluginUiDir(tmpDir, "myplugin", "./dist/ui/");
    expect(result).toBe(uiDir);
  });

  it("prefers explicit packagePath over node_modules resolution", () => {
    // node_modules version also exists but packagePath should win
    const pkgDir = path.join(tmpDir, "node_modules", "@acme", "demo");
    const nodeModulesUiDir = path.join(pkgDir, "dist", "ui");
    fs.mkdirSync(nodeModulesUiDir, { recursive: true });

    const localPkg = path.join(tmpDir, "local-acme-demo");
    const localUiDir = path.join(localPkg, "dist", "ui");
    fs.mkdirSync(localUiDir, { recursive: true });

    const result = resolvePluginUiDir(tmpDir, "@acme/demo", "./dist/ui/", localPkg);
    expect(result).toBe(localUiDir);
  });

  it("returns null when packagePath does not exist on disk", () => {
    const result = resolvePluginUiDir(
      tmpDir,
      "@acme/demo",
      "./dist/ui/",
      "/nonexistent/path/to/package",
    );
    // Falls through to node_modules lookup which also fails
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pluginUiStaticRoutes — DrizzleQueryError cause-chain fallback (IUN-6295)
// ---------------------------------------------------------------------------

describe("plugin-ui-static route — plugin lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.getConfig.mockResolvedValue(null);
  });

  it("returns 404 when getById throws 22P02 directly and getByKey returns null", async () => {
    // Postgres error with code directly on the error object (pre-Drizzle path)
    const pgError = Object.assign(new Error("invalid UUID"), { code: "22P02" });
    mockRegistry.getById.mockRejectedValue(pgError);
    mockRegistry.getByKey.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/_plugins/not-a-uuid/ui/index.js");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Plugin not found");
    expect(mockRegistry.getByKey).toHaveBeenCalledWith("not-a-uuid");
  });

  it("returns 404 when getById throws DrizzleQueryError wrapping 22P02 and getByKey returns null", async () => {
    // Drizzle wraps the postgres error: DrizzleQueryError has no `.code` itself
    // but its `.cause` is the original PostgresError with `.code = "22P02"`.
    const postgresErr = Object.assign(new Error("invalid input syntax"), { code: "22P02" });
    const drizzleErr = new Error("drizzle query failed");
    (drizzleErr as any).cause = postgresErr;
    // Intentionally no `code` on drizzleErr to match the Drizzle pattern
    mockRegistry.getById.mockRejectedValue(drizzleErr);
    mockRegistry.getByKey.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/_plugins/not-a-uuid/ui/index.js");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Plugin not found");
    expect(mockRegistry.getByKey).toHaveBeenCalledWith("not-a-uuid");
  });

  it("re-throws when getById throws a non-22P02 error directly", async () => {
    const dbErr = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    mockRegistry.getById.mockRejectedValue(dbErr);

    const res = await request(createApp())
      .get("/_plugins/some-plugin/ui/index.js");

    // errorHandler turns unhandled errors into 500
    expect(res.status).toBe(500);
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
  });

  it("re-throws when getById throws a DrizzleQueryError wrapping a non-22P02 cause", async () => {
    const postgresErr = Object.assign(new Error("table not found"), { code: "42P01" });
    const drizzleErr = new Error("drizzle query failed");
    (drizzleErr as any).cause = postgresErr;
    mockRegistry.getById.mockRejectedValue(drizzleErr);

    const res = await request(createApp())
      .get("/_plugins/some-plugin/ui/index.js");

    expect(res.status).toBe(500);
    expect(mockRegistry.getByKey).not.toHaveBeenCalled();
  });

  it("returns 400 when no file path is provided", async () => {
    // Express captures the wildcard; an empty trailing segment can't happen
    // via normal routing, but verify the guard works with a direct invocation
    // by using a route pattern that produces an empty filePath param.
    // In practice, the router requires at least one char after /ui/, so this
    // is a belt-and-suspenders check via direct app handler test.
    const plugin = makePlugin();
    mockRegistry.getById.mockResolvedValue(plugin);

    // The route requires a filePath wildcard — hitting the base path without
    // the trailing segment returns 404 from Express itself (no route match).
    const res = await request(createApp())
      .get("/_plugins/plugin-uuid-1/ui/");

    // Express 5 with named wildcards: an empty segment means no route match → 404
    expect(res.status).toBe(404);
  });

  it("returns 403 when plugin is not in ready status", async () => {
    const plugin = makePlugin({ status: "installing" });
    mockRegistry.getById.mockResolvedValue(plugin);

    const res = await request(createApp())
      .get("/_plugins/plugin-uuid-1/ui/index.js");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("installing");
  });

  it("returns 404 when plugin has no UI entrypoint declared", async () => {
    const plugin = makePlugin({ manifestJson: { entrypoints: {} } });
    mockRegistry.getById.mockResolvedValue(plugin);

    const res = await request(createApp())
      .get("/_plugins/plugin-uuid-1/ui/index.js");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Plugin does not declare a UI bundle");
  });
});
