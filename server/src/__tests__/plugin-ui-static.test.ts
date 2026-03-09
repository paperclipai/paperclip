import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const registry = {
  list: vi.fn(),
  listByStatus: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
};

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => registry),
}));

import { pluginUiStaticRoutes, resolvePluginUiDir } from "../routes/plugin-ui-static.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-ui-test-"));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  tempDirs.length = 0;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createPluginWithUi(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    pluginKey: "acme.test",
    version: "1.0.0",
    status: "ready",
    packageName: "paperclip-plugin-test",
    packagePath: null,
    installedAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    manifestJson: {
      id: "acme.test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      author: "Test Author",
      categories: ["connector"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui/" },
      ui: {
        slots: [
          {
            type: "page",
            id: "main",
            displayName: "Main",
            exportName: "MainPage",
          },
        ],
      },
    },
    ...overrides,
  };
}

function createApp(localPluginDir: string) {
  const app = express();
  app.use(express.json());
  // No auth middleware needed for these tests — the route itself doesn't
  // check req.actor (plugin UI is served to any authenticated user)
  app.use(pluginUiStaticRoutes({} as never, { localPluginDir }));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status) || 500
          : 500;
      const message = error instanceof Error ? error.message : "Unexpected error";
      res.status(status).json({ error: message });
    },
  );
  return app;
}

/**
 * Set up a temp directory mimicking the plugin installation layout:
 * <localPluginDir>/node_modules/<packageName>/dist/ui/
 */
function setupPluginDir(localPluginDir: string, packageName: string) {
  let packageDir: string;
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    packageDir = path.join(localPluginDir, "node_modules", scope!, name!);
  } else {
    packageDir = path.join(localPluginDir, "node_modules", packageName);
  }
  const uiDir = path.join(packageDir, "dist", "ui");
  fs.mkdirSync(uiDir, { recursive: true });
  return { packageDir, uiDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin UI static routes", () => {
  let localPluginDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    registry.getById.mockResolvedValue(null);
    registry.getByKey.mockResolvedValue(null);
    localPluginDir = mkTmpDir();
  });

  afterEach(() => {
    cleanupTempDirs();
  });

  // -------------------------------------------------------------------------
  // Basic file serving
  // -------------------------------------------------------------------------

  describe("GET /_plugins/:pluginId/ui/*", () => {
    it("serves a JS file from the plugin's UI directory", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), 'console.log("hello");');

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(200);
      expect(res.text).toContain('console.log("hello")');
      expect(res.headers["content-type"]).toContain("application/javascript");
    });

    it("serves a CSS file with correct content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "styles.css"), "body { margin: 0; }");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/styles.css");

      expect(res.status).toBe(200);
      expect(res.text).toContain("body { margin: 0; }");
      expect(res.headers["content-type"]).toContain("text/css");
    });

    it("serves files from nested directories", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      const nestedDir = path.join(uiDir, "assets", "js");
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, "chunk.js"), "export const x = 1;");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/assets/js/chunk.js");

      expect(res.status).toBe(200);
      expect(res.text).toContain("export const x = 1;");
      expect(res.headers["content-type"]).toContain("application/javascript");
    });

    it("resolves plugin by key when ID lookup fails", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(null);
      registry.getByKey.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "export default {};");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/acme.test/ui/index.js");

      expect(res.status).toBe(200);
      expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
    });

    it("serves UI files for local-path installs via packagePath", async () => {
      const localPluginPackagePath = mkTmpDir();
      const plugin = createPluginWithUi({
        packageName: "@paperclipai/plugin-file-browser-example",
        packagePath: localPluginPackagePath,
      });
      registry.getById.mockResolvedValue(plugin);

      const uiDir = path.join(localPluginPackagePath, "dist", "ui");
      fs.mkdirSync(uiDir, { recursive: true });
      fs.writeFileSync(path.join(uiDir, "index.js"), "export const localPathUi = true;");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(200);
      expect(res.text).toContain("localPathUi");
    });
  });

  // -------------------------------------------------------------------------
  // Cache headers
  // -------------------------------------------------------------------------

  describe("cache headers", () => {
    it("sets immutable cache for content-hashed filenames", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index-a1b2c3d4e5f6.js"), "hashed content");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index-a1b2c3d4e5f6.js");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("sets immutable cache for dot-separated hashed filenames", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "styles.abcdef0123456789.css"), "hashed css");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/styles.abcdef0123456789.css");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("sets revalidate cache with ETag for non-hashed files", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "non-hashed content");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(res.headers["etag"]).toBeDefined();
    });

    it("returns 304 when If-None-Match matches ETag", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "content for etag test");

      const app = createApp(localPluginDir);

      // First request to get the ETag
      const res1 = await request(app).get("/_plugins/p1/ui/index.js");
      expect(res1.status).toBe(200);
      const etag = res1.headers["etag"];
      expect(etag).toBeDefined();

      // Second request with If-None-Match
      // Reset mock since it was consumed
      registry.getById.mockResolvedValue(plugin);
      const res2 = await request(app)
        .get("/_plugins/p1/ui/index.js")
        .set("If-None-Match", etag);

      expect(res2.status).toBe(304);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns 404 when plugin is not found", async () => {
      registry.getById.mockResolvedValue(null);
      registry.getByKey.mockResolvedValue(null);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/nonexistent/ui/index.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Plugin not found");
    });

    it("returns 403 when plugin is not in ready status", async () => {
      const plugin = createPluginWithUi({ status: "installed" });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("not available");
    });

    it("returns 404 when plugin has no UI entrypoint", async () => {
      const plugin = createPluginWithUi({
        manifestJson: {
          id: "acme.test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Test Plugin",
          description: "A test plugin",
          categories: ["connector"],
          capabilities: [],
          entrypoints: { worker: "./dist/worker.js" },
          // No ui field
        },
      });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not declare a UI bundle");
    });

    it("returns 404 when UI directory does not exist on disk", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);
      // Don't create the directory — simulate missing files

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("UI directory not found");
    });

    it("returns 404 when requested file does not exist", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      // Create the UI dir but not the requested file
      fs.writeFileSync(path.join(uiDir, "other.js"), "other");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/nonexistent.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("File not found");
    });

    it("returns 404 for path traversal attempts (Express normalizes URL)", async () => {
      // Express 5 normalizes `../` segments in the URL before routing,
      // so path traversal via `..` is already blocked at the HTTP layer.
      // The wildcard capture never receives `..` segments.
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "ok");

      const app = createApp(localPluginDir);
      // After Express normalizes /_plugins/p1/ui/../../../etc/passwd,
      // the resolved path won't match the route or won't find a file.
      const res = await request(app).get("/_plugins/p1/ui/../../../etc/passwd");

      // The traversal attempt is blocked — it either doesn't match the route
      // or resolves to a non-existent file. Either way, it does NOT serve /etc/passwd.
      expect([403, 404]).toContain(res.status);
    });

    it("blocks encoded path traversal attempts", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "ok");

      const app = createApp(localPluginDir);
      // Try URL-encoded `..` — Express should still normalize this
      const res = await request(app).get("/_plugins/p1/ui/%2e%2e/%2e%2e/etc/passwd");

      expect([400, 403, 404]).toContain(res.status);
    });

    it("returns 404 when trying to serve a directory", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      const subDir = path.join(uiDir, "assets");
      fs.mkdirSync(subDir);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/assets");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("File not found");
    });
  });

  // -------------------------------------------------------------------------
  // Scoped packages
  // -------------------------------------------------------------------------

  describe("scoped packages", () => {
    it("serves files from scoped package directories", async () => {
      const plugin = createPluginWithUi({ packageName: "@acme/plugin-test" });
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, "@acme/plugin-test");
      fs.writeFileSync(path.join(uiDir, "index.js"), "scoped content");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(200);
      expect(res.text).toContain("scoped content");
    });
  });

  // -------------------------------------------------------------------------
  // CORS headers
  // -------------------------------------------------------------------------

  describe("CORS headers", () => {
    it("sets Access-Control-Allow-Origin header", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js"), "content");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  // -------------------------------------------------------------------------
  // MIME type handling
  // -------------------------------------------------------------------------

  describe("MIME type handling", () => {
    it("serves .mjs files with application/javascript content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "chunk.mjs"), "export const x = 1;");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/chunk.mjs");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/javascript");
    });

    it("serves .json files with application/json content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "translations.json"), '{"key": "value"}');

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/translations.json");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("serves .svg files with image/svg+xml content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "icon.svg"), "<svg></svg>");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/icon.svg");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("image/svg+xml");
    });

    it("serves .woff2 files with font/woff2 content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      // Write a minimal binary-like file
      fs.writeFileSync(path.join(uiDir, "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/font.woff2");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("font/woff2");
    });

    it("serves .map files with application/json content-type", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "index.js.map"), '{"version": 3}');

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js.map");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });
  });

  // -------------------------------------------------------------------------
  // Manifest edge cases
  // -------------------------------------------------------------------------

  describe("manifest edge cases", () => {
    it("returns 404 when manifest is null", async () => {
      const plugin = createPluginWithUi({ manifestJson: null });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not declare a UI bundle");
    });

    it("returns 404 when entrypoints has no ui field", async () => {
      const plugin = createPluginWithUi({
        manifestJson: {
          id: "acme.test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Test Plugin",
          description: "A test plugin",
          categories: ["connector"],
          capabilities: [],
          entrypoints: { worker: "./dist/worker.js" },
        },
      });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(404);
      expect(res.body.error).toContain("does not declare a UI bundle");
    });

    it("returns 403 for error-status plugins", async () => {
      const plugin = createPluginWithUi({ status: "error" });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("not available");
    });

    it("returns 403 for uninstalled plugins", async () => {
      const plugin = createPluginWithUi({ status: "uninstalled" });
      registry.getById.mockResolvedValue(plugin);

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/index.js");

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("not available");
    });
  });

  // -------------------------------------------------------------------------
  // Content-hash pattern matching
  // -------------------------------------------------------------------------

  describe("content-hash pattern matching", () => {
    it("detects chunk filenames with content hashes", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "chunk-ABCDEF01.mjs"), "export const x = 1;");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/chunk-ABCDEF01.mjs");

      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    });

    it("does not treat short hashes (less than 8 chars) as content-hashed", async () => {
      const plugin = createPluginWithUi();
      registry.getById.mockResolvedValue(plugin);

      const { uiDir } = setupPluginDir(localPluginDir, plugin.packageName);
      fs.writeFileSync(path.join(uiDir, "chunk-abc123.js"), "short hash");

      const app = createApp(localPluginDir);
      const res = await request(app).get("/_plugins/p1/ui/chunk-abc123.js");

      expect(res.status).toBe(200);
      // 6 hex chars is too short for content hash detection — should get revalidate
      expect(res.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(res.headers["etag"]).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// resolvePluginUiDir unit tests
// ---------------------------------------------------------------------------

describe("resolvePluginUiDir", () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it("resolves UI dir for a non-scoped package", () => {
    const localPluginDir = mkTmpDir();
    const uiPath = path.join(
      localPluginDir,
      "node_modules",
      "paperclip-plugin-test",
      "dist",
      "ui",
    );
    fs.mkdirSync(uiPath, { recursive: true });

    const result = resolvePluginUiDir(
      localPluginDir,
      "paperclip-plugin-test",
      "./dist/ui/",
    );

    expect(result).toBe(uiPath);
  });

  it("resolves UI dir for a scoped package", () => {
    const localPluginDir = mkTmpDir();
    const uiPath = path.join(
      localPluginDir,
      "node_modules",
      "@acme",
      "plugin-test",
      "dist",
      "ui",
    );
    fs.mkdirSync(uiPath, { recursive: true });

    const result = resolvePluginUiDir(
      localPluginDir,
      "@acme/plugin-test",
      "./dist/ui/",
    );

    expect(result).toBe(uiPath);
  });

  it("returns null when package directory does not exist", () => {
    const localPluginDir = mkTmpDir();

    const result = resolvePluginUiDir(
      localPluginDir,
      "nonexistent-plugin",
      "./dist/ui/",
    );

    expect(result).toBeNull();
  });

  it("returns null when UI directory does not exist within package", () => {
    const localPluginDir = mkTmpDir();
    const packageDir = path.join(
      localPluginDir,
      "node_modules",
      "paperclip-plugin-test",
    );
    fs.mkdirSync(packageDir, { recursive: true });
    // Don't create dist/ui/ — only the package root exists

    const result = resolvePluginUiDir(
      localPluginDir,
      "paperclip-plugin-test",
      "./dist/ui/",
    );

    expect(result).toBeNull();
  });

  it("handles custom entrypoint paths", () => {
    const localPluginDir = mkTmpDir();
    const uiPath = path.join(
      localPluginDir,
      "node_modules",
      "paperclip-plugin-test",
      "build",
      "frontend",
    );
    fs.mkdirSync(uiPath, { recursive: true });

    const result = resolvePluginUiDir(
      localPluginDir,
      "paperclip-plugin-test",
      "./build/frontend",
    );

    expect(result).toBe(uiPath);
  });

  it("prefers packagePath when provided (local-path install)", () => {
    const localPluginDir = mkTmpDir();
    const packagePath = mkTmpDir();
    const uiPath = path.join(packagePath, "dist", "ui");
    fs.mkdirSync(uiPath, { recursive: true });

    const result = resolvePluginUiDir(
      localPluginDir,
      "paperclip-plugin-test",
      "./dist/ui/",
      packagePath,
    );

    expect(result).toBe(uiPath);
  });
});
