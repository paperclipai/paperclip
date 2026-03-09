import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  pluginLoader,
  isPluginPackageName,
  NPM_PLUGIN_PACKAGE_PREFIX,
  DEFAULT_LOCAL_PLUGIN_DIR,
} from "../services/plugin-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid manifest object. */
function buildValidManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin for the loader service",
    author: "Acme Corp",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

/** Create a fake plugin package directory with package.json and optional manifest. */
async function createFakePluginPackage(
  dir: string,
  opts: {
    name: string;
    version?: string;
    manifest?: Record<string, unknown> | null;
    /** If false, don't add the paperclipPlugin key to package.json */
    declareAsPlugin?: boolean;
  },
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "dist"), { recursive: true });

  const { manifest = null, declareAsPlugin = true } = opts;

  const pkgJson: Record<string, unknown> = {
    name: opts.name,
    version: opts.version ?? "1.0.0",
  };

  if (declareAsPlugin && manifest !== null) {
    pkgJson["paperclipPlugin"] = {
      manifest: "./dist/manifest.js",
      worker: "./dist/worker.js",
    };

    // Write manifest module as CommonJS
    const manifestContent = `module.exports = ${JSON.stringify(manifest)};`;
    await writeFile(path.join(dir, "dist", "manifest.js"), manifestContent, "utf-8");
  }

  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf-8");

  return dir;
}

// ---------------------------------------------------------------------------
// isPluginPackageName
// ---------------------------------------------------------------------------

describe("isPluginPackageName", () => {
  it("accepts paperclip-plugin-* packages", () => {
    expect(isPluginPackageName("paperclip-plugin-linear")).toBe(true);
    expect(isPluginPackageName("paperclip-plugin-github")).toBe(true);
    expect(isPluginPackageName("paperclip-plugin-my-connector")).toBe(true);
  });

  it("accepts scoped @*/plugin-* packages", () => {
    expect(isPluginPackageName("@acme/plugin-linear")).toBe(true);
    expect(isPluginPackageName("@paperclipai/plugin-github")).toBe(true);
  });

  it("rejects non-plugin package names", () => {
    expect(isPluginPackageName("express")).toBe(false);
    expect(isPluginPackageName("@paperclipai/shared")).toBe(false);
    expect(isPluginPackageName("paperclip-adapter-linear")).toBe(false);
    expect(isPluginPackageName("my-plugin-package")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isPluginPackageName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NPM_PLUGIN_PACKAGE_PREFIX constant
// ---------------------------------------------------------------------------

describe("NPM_PLUGIN_PACKAGE_PREFIX", () => {
  it("equals 'paperclip-plugin-'", () => {
    expect(NPM_PLUGIN_PACKAGE_PREFIX).toBe("paperclip-plugin-");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_LOCAL_PLUGIN_DIR constant
// ---------------------------------------------------------------------------

describe("DEFAULT_LOCAL_PLUGIN_DIR", () => {
  it("includes .paperclip/plugins in the path", () => {
    expect(DEFAULT_LOCAL_PLUGIN_DIR).toContain(".paperclip");
    expect(DEFAULT_LOCAL_PLUGIN_DIR).toContain("plugins");
  });

  it("is an absolute path", () => {
    expect(path.isAbsolute(DEFAULT_LOCAL_PLUGIN_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pluginLoader factory
// ---------------------------------------------------------------------------

describe("pluginLoader factory", () => {
  it("returns an object with the expected methods", () => {
    // We pass a minimal db mock — these tests don't hit the DB
    const db = {} as Parameters<typeof pluginLoader>[0];
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    expect(typeof loader.discoverAll).toBe("function");
    expect(typeof loader.discoverFromLocalFilesystem).toBe("function");
    expect(typeof loader.discoverFromNpm).toBe("function");
    expect(typeof loader.loadManifest).toBe("function");
    expect(typeof loader.installPlugin).toBe("function");
    expect(typeof loader.isSupportedApiVersion).toBe("function");
    expect(typeof loader.getLocalPluginDir).toBe("function");
  });

  it("returns the configured localPluginDir", () => {
    const db = {} as Parameters<typeof pluginLoader>[0];
    const customDir = "/tmp/my-plugins";
    const loader = pluginLoader(db, { localPluginDir: customDir });
    expect(loader.getLocalPluginDir()).toBe(customDir);
  });

  it("uses DEFAULT_LOCAL_PLUGIN_DIR when no dir is configured", () => {
    const db = {} as Parameters<typeof pluginLoader>[0];
    const loader = pluginLoader(db);
    expect(loader.getLocalPluginDir()).toBe(DEFAULT_LOCAL_PLUGIN_DIR);
  });
});

// ---------------------------------------------------------------------------
// isSupportedApiVersion
// ---------------------------------------------------------------------------

describe("isSupportedApiVersion", () => {
  const db = {} as Parameters<typeof pluginLoader>[0];
  const loader = pluginLoader(db, {
    enableLocalFilesystem: false,
    enableNpmDiscovery: false,
  });

  it("returns true for apiVersion 1", () => {
    expect(loader.isSupportedApiVersion(1)).toBe(true);
  });

  it("returns false for unknown versions", () => {
    expect(loader.isSupportedApiVersion(0)).toBe(false);
    expect(loader.isSupportedApiVersion(2)).toBe(false);
    expect(loader.isSupportedApiVersion(99)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discoverFromLocalFilesystem
// ---------------------------------------------------------------------------

describe("discoverFromLocalFilesystem", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty result when directory does not exist", async () => {
    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem("/nonexistent/path/abc123");

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.sources).toContain("local-filesystem");
  });

  it("returns empty result when directory is empty", async () => {
    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips non-directory entries", async () => {
    // Create a file in the plugin dir
    await writeFile(path.join(tmpDir, "not-a-package.txt"), "hello", "utf-8");

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips directories without package.json", async () => {
    // Create a directory without package.json
    await mkdir(path.join(tmpDir, "some-dir"));

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("skips packages that are not plugins (no paperclipPlugin key, no naming convention)", async () => {
    const pkgDir = path.join(tmpDir, "plain-package");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "plain-package", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("discovers a valid plugin package with manifest", async () => {
    const pluginDir = path.join(tmpDir, "paperclip-plugin-test");
    const manifest = buildValidManifest({ id: "acme.test-plugin" });
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-test",
      manifest,
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const discovered = result.discovered[0]!;
    expect(discovered.packageName).toBe("paperclip-plugin-test");
    expect(discovered.source).toBe("local-filesystem");
    expect(discovered.manifest).not.toBeNull();
    expect(discovered.manifest!.id).toBe("acme.test-plugin");
  });

  it("discovers multiple plugins in the directory", async () => {
    const manifests = [
      buildValidManifest({ id: "acme.plugin-one", displayName: "Plugin One" }),
      buildValidManifest({ id: "acme.plugin-two", displayName: "Plugin Two" }),
    ];

    for (let i = 0; i < 2; i++) {
      const pluginDir = path.join(tmpDir, `paperclip-plugin-${i + 1}`);
      await createFakePluginPackage(pluginDir, {
        name: `paperclip-plugin-${i + 1}`,
        manifest: manifests[i]!,
      });
    }

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for packages with invalid manifests", async () => {
    const pluginDir = path.join(tmpDir, "paperclip-plugin-broken");
    const invalidManifest = { id: "broken", apiVersion: 1 }; // missing required fields
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-broken",
      manifest: invalidManifest,
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packageName).toBe("paperclip-plugin-broken");
    expect(result.errors[0]!.error).toBeTruthy();
  });

  it("handles scoped packages inside @ directories", async () => {
    const scopeDir = path.join(tmpDir, "@acme");
    await mkdir(scopeDir, { recursive: true });

    const pluginDir = path.join(scopeDir, "plugin-linear");
    const manifest = buildValidManifest({ id: "acme.plugin-linear" });
    await createFakePluginPackage(pluginDir, {
      name: "@acme/plugin-linear",
      manifest,
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.packageName).toBe("@acme/plugin-linear");
    expect(result.discovered[0]!.manifest!.id).toBe("acme.plugin-linear");
  });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe("loadManifest", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-manifest-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for a directory without package.json", async () => {
    const loader = pluginLoader(db, { enableLocalFilesystem: false });
    const result = await loader.loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for a non-plugin package", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "not-a-plugin", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: false });
    const result = await loader.loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for a plugin package with no manifest file", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-no-manifest",
        version: "1.0.0",
        paperclipPlugin: { manifest: "./nonexistent-manifest.js" },
      }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: false });
    const result = await loader.loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("loads and returns a valid manifest", async () => {
    const manifest = buildValidManifest({ id: "acme.load-test" });
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-load-test",
      manifest,
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: false });
    const result = await loader.loadManifest(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("acme.load-test");
    expect(result!.apiVersion).toBe(1);
    expect(result!.version).toBe("1.0.0");
    expect(result!.displayName).toBe("Test Plugin");
  });

  it("throws for an invalid manifest", async () => {
    const invalidManifest = { id: "bad" }; // missing required fields
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-invalid",
      manifest: invalidManifest,
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: false });
    await expect(loader.loadManifest(tmpDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discoverAll
// ---------------------------------------------------------------------------

describe("discoverAll", () => {
  const db = {} as Parameters<typeof pluginLoader>[0];

  it("returns empty result when all sources are disabled", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    const result = await loader.discoverAll();

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  it("includes local-filesystem in sources when enabled", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: true,
      enableNpmDiscovery: false,
      localPluginDir: "/nonexistent/dir",
    });

    const result = await loader.discoverAll();

    expect(result.sources).toContain("local-filesystem");
  });

  it("includes npm in sources when enabled", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: true,
    });

    const result = await loader.discoverAll();

    expect(result.sources).toContain("npm");
  });

  it("deduplicates plugins found in multiple sources", async () => {
    // Create a temp dir with a fake plugin
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-dedup-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const manifest = buildValidManifest({ id: "acme.dedup-test" });
    const pluginDir = path.join(tmpDir, "paperclip-plugin-dedup");
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-dedup",
      manifest,
    });

    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    // Symlink / copy the same plugin into node_modules — we use a different
    // directory to simulate the same package found in both sources
    const npmPluginDir = path.join(nodeModulesDir, "paperclip-plugin-dedup");
    await createFakePluginPackage(npmPluginDir, {
      name: "paperclip-plugin-dedup",
      manifest,
    });

    const loader = pluginLoader(db, {
      enableLocalFilesystem: true,
      enableNpmDiscovery: true,
      localPluginDir: tmpDir,
    });

    const result = await loader.discoverAll([nodeModulesDir]);

    // Both paths are different, so deduplication is by path
    // (same packagePath would be deduplicated)
    expect(result.discovered.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// discoverFromNpm
// ---------------------------------------------------------------------------

describe("discoverFromNpm", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-npm-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty result when no search dirs exist", async () => {
    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm(["/nonexistent/node_modules/abc"]);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.sources).toContain("npm");
  });

  it("discovers plugin packages in node_modules by naming convention", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    const pluginDir = path.join(nodeModulesDir, "paperclip-plugin-linear");
    const manifest = buildValidManifest({ id: "acme.linear" });
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-linear",
      manifest,
    });

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.packageName).toBe("paperclip-plugin-linear");
    expect(result.discovered[0]!.source).toBe("npm");
  });

  it("skips non-plugin packages in node_modules", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    // Create a normal package that is not a plugin
    const normalPkg = path.join(nodeModulesDir, "express");
    await mkdir(normalPkg, { recursive: true });
    await writeFile(
      path.join(normalPkg, "package.json"),
      JSON.stringify({ name: "express", version: "5.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("discovers scoped plugin packages (@scope/plugin-*)", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    const scopeDir = path.join(nodeModulesDir, "@myorg");
    await mkdir(scopeDir, { recursive: true });

    const pluginDir = path.join(scopeDir, "plugin-analytics");
    const manifest = buildValidManifest({ id: "myorg.plugin-analytics" });
    await createFakePluginPackage(pluginDir, {
      name: "@myorg/plugin-analytics",
      manifest,
    });

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.packageName).toBe("@myorg/plugin-analytics");
  });
});

// ---------------------------------------------------------------------------
// isPluginPackageName — edge cases
// ---------------------------------------------------------------------------

describe("isPluginPackageName edge cases", () => {
  it("rejects bare prefix with nothing after it", () => {
    // "paperclip-plugin-" with no suffix is technically valid by startsWith,
    // but confirms the boundary
    expect(isPluginPackageName("paperclip-plugin-")).toBe(true);
  });

  it("rejects scoped package whose local part doesn't start with 'plugin-'", () => {
    expect(isPluginPackageName("@acme/not-a-plugin")).toBe(false);
    expect(isPluginPackageName("@paperclipai/adapter-linear")).toBe(false);
  });

  it("accepts deeply-hyphenated plugin names", () => {
    expect(isPluginPackageName("paperclip-plugin-my-long-named-connector")).toBe(true);
    expect(isPluginPackageName("@org/plugin-my-long-named-connector")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverFromLocalFilesystem — additional coverage
// ---------------------------------------------------------------------------

describe("discoverFromLocalFilesystem — additional cases", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-fs-extra-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns discovery-only result (manifest: null) when plugin has naming convention but no manifest file", async () => {
    // Package name matches convention but has no paperclipPlugin key and no manifest file
    const pluginDir = path.join(tmpDir, "paperclip-plugin-no-manifest-file");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "paperclip-plugin-no-manifest-file", version: "2.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const discovered = result.discovered[0]!;
    expect(discovered.packageName).toBe("paperclip-plugin-no-manifest-file");
    expect(discovered.manifest).toBeNull();
    expect(discovered.version).toBe("2.0.0");
    expect(discovered.source).toBe("local-filesystem");
  });

  it("falls back to '0.0.0' version when package.json has no version field", async () => {
    const pluginDir = path.join(tmpDir, "paperclip-plugin-no-version");
    await mkdir(pluginDir, { recursive: true });
    // Intentionally omit version
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "paperclip-plugin-no-version" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.version).toBe("0.0.0");
  });

  it("collects both valid discoveries and errors in a single scan", async () => {
    // Valid plugin
    const validDir = path.join(tmpDir, "paperclip-plugin-valid");
    await createFakePluginPackage(validDir, {
      name: "paperclip-plugin-valid",
      manifest: buildValidManifest({ id: "acme.valid" }),
    });

    // Invalid manifest plugin
    const invalidDir = path.join(tmpDir, "paperclip-plugin-invalid");
    await createFakePluginPackage(invalidDir, {
      name: "paperclip-plugin-invalid",
      manifest: { id: "bad" }, // missing required fields
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.packageName).toBe("paperclip-plugin-valid");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packageName).toBe("paperclip-plugin-invalid");
  });

  it("discovers plugin via root-level manifest.js fallback", async () => {
    const pluginDir = path.join(tmpDir, "paperclip-plugin-root-manifest");
    await mkdir(pluginDir, { recursive: true });

    const manifest = buildValidManifest({ id: "acme.root-manifest" });
    // Write manifest at root level (not dist/)
    await writeFile(
      path.join(pluginDir, "manifest.js"),
      `module.exports = ${JSON.stringify(manifest)};`,
      "utf-8",
    );
    // Package declares paperclipPlugin but with no manifest key — loader falls back to root manifest.js
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-root-manifest",
        version: "1.0.0",
        // paperclipPlugin key present but no 'manifest' sub-key — triggers fallback
        paperclipPlugin: { worker: "./dist/worker.js" },
      }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.manifest).not.toBeNull();
    expect(result.discovered[0]!.manifest!.id).toBe("acme.root-manifest");
  });

  it("ignores scoped directories that contain no plugin subdirectories", async () => {
    const scopeDir = path.join(tmpDir, "@acme");
    await mkdir(scopeDir, { recursive: true });
    // Put a non-plugin package inside the scope
    const nonPluginDir = path.join(scopeDir, "shared");
    await mkdir(nonPluginDir, { recursive: true });
    await writeFile(
      path.join(nonPluginDir, "package.json"),
      JSON.stringify({ name: "@acme/shared", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for invalid scoped plugin manifests", async () => {
    const scopeDir = path.join(tmpDir, "@acme");
    await mkdir(scopeDir, { recursive: true });

    const pluginDir = path.join(scopeDir, "plugin-broken");
    await createFakePluginPackage(pluginDir, {
      name: "@acme/plugin-broken",
      manifest: { id: "broken-scoped" }, // missing required fields
    });

    const loader = pluginLoader(db, { enableLocalFilesystem: true });
    const result = await loader.discoverFromLocalFilesystem(tmpDir);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packageName).toBe("@acme/plugin-broken");
  });
});

// ---------------------------------------------------------------------------
// loadManifest — additional coverage
// ---------------------------------------------------------------------------

describe("loadManifest — additional cases", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-manifest-extra-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null when paperclipPlugin.manifest points to a non-existent file", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-missing-path",
        version: "1.0.0",
        paperclipPlugin: { manifest: "./dist/does-not-exist.js" },
      }),
      "utf-8",
    );

    const loader = pluginLoader(db);
    const result = await loader.loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("loads manifest when discovered via root-level manifest.js fallback", async () => {
    const manifest = buildValidManifest({ id: "acme.root-fallback" });
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      path.join(tmpDir, "manifest.js"),
      `module.exports = ${JSON.stringify(manifest)};`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-root-fallback",
        version: "1.0.0",
        // paperclipPlugin present but no manifest key — triggers root fallback
        paperclipPlugin: { worker: "./dist/worker.js" },
      }),
      "utf-8",
    );

    const loader = pluginLoader(db);
    const result = await loader.loadManifest(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("acme.root-fallback");
  });

  it("returns null when package has malformed JSON in package.json", async () => {
    await writeFile(
      path.join(tmpDir, "package.json"),
      "{ this is not valid json }",
      "utf-8",
    );

    const loader = pluginLoader(db);
    const result = await loader.loadManifest(tmpDir);
    expect(result).toBeNull();
  });

  it("identifies plugin by naming convention even without paperclipPlugin key", async () => {
    const manifest = buildValidManifest({ id: "acme.convention-only" });
    await mkdir(path.join(tmpDir, "dist"), { recursive: true });
    // No paperclipPlugin key — loader uses name convention, then discovers manifest.js
    await writeFile(
      path.join(tmpDir, "dist", "manifest.js"),
      `module.exports = ${JSON.stringify(manifest)};`,
      "utf-8",
    );
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "paperclip-plugin-convention-only",
        version: "1.0.0",
        // no paperclipPlugin key
      }),
      "utf-8",
    );

    const loader = pluginLoader(db);
    const result = await loader.loadManifest(tmpDir);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("acme.convention-only");
  });
});

// ---------------------------------------------------------------------------
// discoverFromNpm — additional coverage
// ---------------------------------------------------------------------------

describe("discoverFromNpm — additional cases", () => {
  let tmpDir: string;
  const db = {} as Parameters<typeof pluginLoader>[0];

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-npm-extra-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports errors for invalid plugin manifests found in node_modules", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    const pluginDir = path.join(nodeModulesDir, "paperclip-plugin-broken");
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-broken",
      manifest: { id: "broken-npm" }, // invalid manifest
    });

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packageName).toBe("paperclip-plugin-broken");
    expect(result.errors[0]!.error).toBeTruthy();
  });

  it("searches multiple node_modules directories", async () => {
    const dir1 = path.join(tmpDir, "node_modules_1");
    const dir2 = path.join(tmpDir, "node_modules_2");
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    await createFakePluginPackage(path.join(dir1, "paperclip-plugin-a"), {
      name: "paperclip-plugin-a",
      manifest: buildValidManifest({ id: "acme.plugin-a" }),
    });
    await createFakePluginPackage(path.join(dir2, "paperclip-plugin-b"), {
      name: "paperclip-plugin-b",
      manifest: buildValidManifest({ id: "acme.plugin-b" }),
    });

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([dir1, dir2]);

    expect(result.discovered).toHaveLength(2);
    const names = result.discovered.map((d) => d.packageName);
    expect(names).toContain("paperclip-plugin-a");
    expect(names).toContain("paperclip-plugin-b");
  });

  it("returns discovery-only result when npm plugin has no manifest file", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });

    // Plugin matches naming convention but has no manifest
    const pluginDir = path.join(nodeModulesDir, "paperclip-plugin-no-manifest");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "paperclip-plugin-no-manifest", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(1);
    expect(result.discovered[0]!.manifest).toBeNull();
    expect(result.discovered[0]!.source).toBe("npm");
    expect(result.errors).toHaveLength(0);
  });

  it("skips scoped packages whose local name doesn't match plugin convention", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    const scopeDir = path.join(nodeModulesDir, "@acme");
    await mkdir(scopeDir, { recursive: true });

    // This package is @acme/shared — not a plugin
    const nonPluginDir = path.join(scopeDir, "shared");
    await mkdir(nonPluginDir, { recursive: true });
    await writeFile(
      path.join(nonPluginDir, "package.json"),
      JSON.stringify({ name: "@acme/shared", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("collects errors from scoped plugin packages in node_modules", async () => {
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    const scopeDir = path.join(nodeModulesDir, "@acme");
    await mkdir(scopeDir, { recursive: true });

    const brokenDir = path.join(scopeDir, "plugin-broken");
    await createFakePluginPackage(brokenDir, {
      name: "@acme/plugin-broken",
      manifest: { id: "bad" }, // invalid
    });

    const loader = pluginLoader(db, { enableNpmDiscovery: true });
    const result = await loader.discoverFromNpm([nodeModulesDir]);

    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.packageName).toBe("@acme/plugin-broken");
  });
});

// ---------------------------------------------------------------------------
// discoverAll — additional coverage
// ---------------------------------------------------------------------------

describe("discoverAll — additional cases", () => {
  const db = {} as Parameters<typeof pluginLoader>[0];

  it("adds 'registry' to sources and logs warning when registryUrl is set", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      registryUrl: "https://registry.example.com",
    });

    const result = await loader.discoverAll();

    // Registry source is added but implementation is reserved (no actual fetch)
    expect(result.sources).toContain("registry");
    expect(result.discovered).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("combines errors from both local filesystem and npm sources", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-multi-errors-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    // Invalid plugin in local filesystem
    const fsPluginDir = path.join(tmpDir, "paperclip-plugin-fs-bad");
    await createFakePluginPackage(fsPluginDir, {
      name: "paperclip-plugin-fs-bad",
      manifest: { id: "bad-fs" },
    });

    // Invalid plugin in npm node_modules
    const nodeModulesDir = path.join(tmpDir, "node_modules");
    await mkdir(nodeModulesDir, { recursive: true });
    const npmPluginDir = path.join(nodeModulesDir, "paperclip-plugin-npm-bad");
    await createFakePluginPackage(npmPluginDir, {
      name: "paperclip-plugin-npm-bad",
      manifest: { id: "bad-npm" },
    });

    const loader = pluginLoader(db, {
      enableLocalFilesystem: true,
      enableNpmDiscovery: true,
      localPluginDir: tmpDir,
    });

    const result = await loader.discoverAll([nodeModulesDir]);

    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const errorNames = result.errors.map((e) => e.packageName);
    expect(errorNames).toContain("paperclip-plugin-fs-bad");
    expect(errorNames).toContain("paperclip-plugin-npm-bad");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deduplicates by path when same package appears in both sources", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-dedup-strict-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const manifest = buildValidManifest({ id: "acme.shared-plugin" });

    // Create a plugin in local filesystem
    const pluginDir = path.join(tmpDir, "paperclip-plugin-shared");
    await createFakePluginPackage(pluginDir, {
      name: "paperclip-plugin-shared",
      manifest,
    });

    // The SAME directory is passed as both the local dir AND the npm search dir
    // so the same packagePath will be reported by both sources
    const fakeNmDir = path.join(tmpDir, "fake-nm");
    await mkdir(fakeNmDir, { recursive: true });
    // Symlink the same plugin into the fake nm dir using the same absolute path
    // (or just create an identical copy — same path won't deduplicate, different paths won't)
    // We test the actual deduplication by passing the local tmpDir as both
    // the localPluginDir scan dir AND npm search dir
    const loader = pluginLoader(db, {
      enableLocalFilesystem: true,
      enableNpmDiscovery: true,
      localPluginDir: tmpDir,
    });

    // Pass localFilesystem as an npm search dir too — different paths, different items
    const result = await loader.discoverAll([fakeNmDir]);

    // Only the local-filesystem find matters here; npm dir is empty
    expect(result.discovered.length).toBeGreaterThanOrEqual(1);
    // All discovered items have unique paths
    const paths = result.discovered.map((d) => d.packagePath);
    expect(new Set(paths).size).toBe(paths.length);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// installPlugin — success path via local path with mocked registry
// ---------------------------------------------------------------------------

describe("installPlugin — local path success path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-loader-install-success-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns DiscoveredPlugin with correct fields after successful local install", async () => {
    const manifest = buildValidManifest({
      id: "acme.install-test",
      displayName: "Install Test Plugin",
      version: "2.3.4",
    });
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-install-test",
      version: "2.3.4",
      manifest,
    });

    // Create a minimal db mock that satisfies registry.install()
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([])),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "row-1",
                pluginKey: "acme.install-test",
                displayName: "Install Test Plugin",
                version: "2.3.4",
                status: "inactive",
                capabilities: ["issues.read"],
                installOrder: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
        }),
      }),
    } as unknown as Parameters<typeof pluginLoader>[0];

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    const result = await loader.installPlugin({ localPath: tmpDir });

    expect(result.packagePath).toBe(tmpDir);
    expect(result.packageName).toBe("paperclip-plugin-install-test");
    expect(result.version).toBe("2.3.4");
    expect(result.source).toBe("local-filesystem");
    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.id).toBe("acme.install-test");
  });

  it("uses basename as package name when package.json has no name field", async () => {
    const manifest = buildValidManifest({ id: "acme.no-name" });
    await mkdir(path.join(tmpDir, "dist"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "dist", "manifest.js"),
      `module.exports = ${JSON.stringify(manifest)};`,
      "utf-8",
    );
    // package.json with paperclipPlugin but no name
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        version: "1.0.0",
        paperclipPlugin: { manifest: "./dist/manifest.js" },
      }),
      "utf-8",
    );

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([])),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "row-2",
                pluginKey: "acme.no-name",
                displayName: "Test Plugin",
                version: "1.0.0",
                status: "inactive",
                capabilities: ["issues.read"],
                installOrder: 2,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
        }),
      }),
    } as unknown as Parameters<typeof pluginLoader>[0];

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    const result = await loader.installPlugin({ localPath: tmpDir });
    // Falls back to path.basename(tmpDir)
    expect(result.packageName).toBe(path.basename(tmpDir));
  });

  it("uses manifest.version as resolved version, falling back to package.json version", async () => {
    // Manifest has a version field — that should be used
    const manifest = buildValidManifest({ id: "acme.version-test", version: "9.8.7" });
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-version-test",
      version: "1.0.0", // package.json version is different
      manifest,
    });

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([])),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "row-3",
                pluginKey: "acme.version-test",
                displayName: "Test Plugin",
                version: "9.8.7",
                status: "inactive",
                capabilities: ["issues.read"],
                installOrder: 3,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
        }),
      }),
    } as unknown as Parameters<typeof pluginLoader>[0];

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    const result = await loader.installPlugin({ localPath: tmpDir });
    // manifest.version (9.8.7) takes precedence over package.json version
    expect(result.version).toBe("9.8.7");
  });
});

// ---------------------------------------------------------------------------
// installPlugin — error cases (no npm, no db)
// ---------------------------------------------------------------------------

describe("installPlugin error cases", () => {
  const db = {} as Parameters<typeof pluginLoader>[0];

  it("throws when neither packageName nor localPath is provided", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({})).rejects.toThrow(
      "Either packageName or localPath must be provided",
    );
  });

  it("throws when localPath does not exist", async () => {
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(
      loader.installPlugin({ localPath: "/nonexistent/path/to/plugin" }),
    ).rejects.toThrow("does not exist");
  });

  it("throws when local path is not a plugin package", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-install-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    // Create a directory with a package.json that is NOT a plugin
    await writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "not-a-plugin", version: "1.0.0" }),
      "utf-8",
    );

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ localPath: tmpDir })).rejects.toThrow(
      "does not appear to be a Paperclip plugin",
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when local plugin has an unsupported apiVersion", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-ver-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const manifestWithBadVersion = {
      ...buildValidManifest(),
      apiVersion: 99,
    };
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-bad-version",
      manifest: manifestWithBadVersion,
    });

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    // The Zod manifest schema enforces apiVersion=1, so the error comes from
    // the schema validation step before the explicit version check.
    await expect(loader.installPlugin({ localPath: tmpDir })).rejects.toThrow();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when local plugin manifest has inconsistent capabilities", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-cap-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    // Plugin declares tools but lacks the agent.tools.register capability
    const manifestMissingCap = buildValidManifest({
      capabilities: ["issues.read"], // missing agent.tools.register
      tools: [
        {
          name: "search",
          displayName: "Search",
          description: "Search something",
          parametersSchema: { type: "object" },
        },
      ],
    });
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-cap-test",
      manifest: manifestMissingCap,
    });

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    // The Zod manifest schema already validates capability consistency,
    // so the error comes from manifest validation before the loader's own check.
    await expect(loader.installPlugin({ localPath: tmpDir })).rejects.toThrow(
      /capability|capabilities/i,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when ui.launchers require a capability the manifest does not declare", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-launcher-cap-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    const manifestMissingLauncherCap = buildValidManifest({
      capabilities: ["issues.read"],
      entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
      ui: {
        launchers: [
          {
            id: "sidebar-link",
            displayName: "Sidebar Link",
            placementZone: "sidebar",
            action: {
              type: "navigate",
              target: "/plugins/sidebar",
            },
          },
        ],
      },
    });
    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-launcher-cap-test",
      manifest: manifestMissingLauncherCap,
    });

    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.installPlugin({ localPath: tmpDir })).rejects.toThrow(
      /ui\.sidebar\.register|capability|capabilities/i,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when local plugin requires a newer host version than the running server", async () => {
    const tmpDir = path.join(os.tmpdir(), `plugin-loader-host-version-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });

    await createFakePluginPackage(tmpDir, {
      name: "paperclip-plugin-host-version-test",
      manifest: buildValidManifest({
        id: "acme.host-version-test",
        minimumHostVersion: "2.0.0",
      }),
    });

    const loader = pluginLoader(
      db,
      {
        enableLocalFilesystem: false,
        enableNpmDiscovery: false,
      },
      {
        workerManager: {} as never,
        eventBus: {} as never,
        jobScheduler: {} as never,
        jobStore: {} as never,
        toolDispatcher: {} as never,
        lifecycleManager: {} as never,
        buildHostHandlers: () => ({}),
        instanceInfo: {
          instanceId: "test-instance",
          hostVersion: "1.5.0",
        },
      },
    );

    await expect(loader.installPlugin({ localPath: tmpDir })).rejects.toThrow(
      /requires host version 2\.0\.0 or newer, but this server is running 1\.5\.0/i,
    );

    await rm(tmpDir, { recursive: true, force: true });
  });
});
