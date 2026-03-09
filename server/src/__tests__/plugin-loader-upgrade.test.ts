import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pluginLoader } from "../services/plugin-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin",
    author: "Acme Corp",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

async function createFakePluginPackage(
  dir: string,
  opts: {
    name: string;
    version?: string;
    manifest?: Record<string, unknown> | null;
  },
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dir, "dist"), { recursive: true });

  const pkgJson: Record<string, unknown> = {
    name: opts.name,
    version: opts.version ?? "1.0.0",
    paperclipPlugin: {
      manifest: "./dist/manifest.js",
      worker: "./dist/worker.js",
    },
  };

  if (opts.manifest) {
    const manifestContent = `module.exports = ${JSON.stringify(opts.manifest)};`;
    await writeFile(path.join(dir, "dist", "manifest.js"), manifestContent, "utf-8");
  }

  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf-8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginLoader.upgradePlugin", () => {
  let tmpDir: string;
  let oldVersionDir: string;
  let newVersionDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `plugin-upgrade-test-${Date.now()}`);
    oldVersionDir = path.join(tmpDir, "old-version");
    newVersionDir = path.join(tmpDir, "new-version");
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("successfully upgrades a plugin to a new version", async () => {
    const oldManifest = buildManifest({ version: "1.0.0" });
    const newManifest = buildManifest({ version: "1.1.0" });

    await createFakePluginPackage(oldVersionDir, {
      name: "paperclip-plugin-test",
      version: "1.0.0",
      manifest: oldManifest,
    });

    await createFakePluginPackage(newVersionDir, {
      name: "paperclip-plugin-test",
      version: "1.1.0",
      manifest: newManifest,
    });

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "plugin-1",
            packageName: "paperclip-plugin-test",
            manifestJson: oldManifest,
          }]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: "plugin-1", version: "1.1.0", manifestJson: newManifest }
            ]),
          }),
        }),
      }),
    } as any;

    const loader = pluginLoader(mockDb, { localPluginDir: tmpDir });
    const result = await loader.upgradePlugin("plugin-1", { localPath: newVersionDir });

    expect(result.oldManifest.version).toBe("1.0.0");
    expect(result.newManifest.version).toBe("1.1.0");
    expect(result.discovered.version).toBe("1.1.0");
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("throws when upgrading to a package with a different plugin ID", async () => {
    const oldManifest = buildManifest({ id: "plugin.a" });
    const newManifest = buildManifest({ id: "plugin.b" });

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{
            id: "plugin-1",
            packageName: "paperclip-plugin-test",
            manifestJson: oldManifest,
          }]),
        }),
      }),
    } as any;

    await createFakePluginPackage(newVersionDir, {
      name: "paperclip-plugin-test",
      manifest: newManifest,
    });

    const loader = pluginLoader(mockDb, { localPluginDir: tmpDir });
    
    await expect(
      loader.upgradePlugin("plugin-1", { localPath: newVersionDir })
    ).rejects.toThrow(/Upgrade failed: new manifest ID 'plugin.b' does not match existing plugin ID 'plugin.a'/);
  });

  it("throws when the plugin to upgrade is not found in the database", async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any;

    const loader = pluginLoader(mockDb, { localPluginDir: tmpDir });
    
    await expect(
      loader.upgradePlugin("nonexistent", { localPath: "/some/path" })
    ).rejects.toThrow(/Plugin not found: nonexistent/);
  });
});
