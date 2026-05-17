import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePluginCacheManifests } from "./plugin-cache-validation.js";

describe("validatePluginCacheManifests", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeCache(root: string): Promise<string> {
    const cacheDir = path.join(root, "plugins", "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  function makeEnv(claudeConfigDir: string): NodeJS.ProcessEnv {
    return { CLAUDE_CONFIG_DIR: claudeConfigDir };
  }

  async function writeManifest(
    cacheDir: string,
    marketplace: string,
    plugin: string,
    version: string,
    content: object,
  ): Promise<string> {
    const dir = path.join(cacheDir, marketplace, plugin, version);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, ".mcp.json");
    await fs.writeFile(filePath, JSON.stringify(content), "utf-8");
    return filePath;
  }

  it("returns empty array when cache directory does not exist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-test-"));
    cleanupDirs.push(root);
    // no plugins/cache directory
    const results = await validatePluginCacheManifests(makeEnv(root));
    expect(results).toEqual([]);
  });

  it("returns valid result for a well-formed manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-test-"));
    cleanupDirs.push(root);
    const cacheDir = await makeCache(root);
    const filePath = await writeManifest(cacheDir, "official", "playwright", "abc123", {
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    });

    const results = await validatePluginCacheManifests(makeEnv(root));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ filePath, valid: true });
  });

  it("flags a manifest with wrong top-level key instead of mcpServers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-test-"));
    cleanupDirs.push(root);
    const cacheDir = await makeCache(root);
    // malformed: uses "playwright" as top-level key (the real fleet-crash shape)
    const filePath = await writeManifest(cacheDir, "official", "playwright", "unknown", {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    });

    const results = await validatePluginCacheManifests(makeEnv(root));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ filePath, valid: false, foundKeys: ["playwright"] });
  });

  it("flags a manifest that is not valid JSON", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-test-"));
    cleanupDirs.push(root);
    const cacheDir = await makeCache(root);
    const dir = path.join(cacheDir, "official", "broken", "v1");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, ".mcp.json");
    await fs.writeFile(filePath, "not-json{{", "utf-8");

    const results = await validatePluginCacheManifests(makeEnv(root));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ filePath, valid: false });
  });

  it("validates multiple manifests independently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pcv-test-"));
    cleanupDirs.push(root);
    const cacheDir = await makeCache(root);

    const good = await writeManifest(cacheDir, "official", "playwright", "abc123", {
      mcpServers: { playwright: { command: "npx", args: [] } },
    });
    const bad = await writeManifest(cacheDir, "official", "playwright", "unknown", {
      playwright: { command: "npx", args: [] },
    });
    const alsoGood = await writeManifest(cacheDir, "official", "github", "def456", {
      mcpServers: { github: { command: "npx", args: [] } },
    });

    const results = await validatePluginCacheManifests(makeEnv(root));
    expect(results).toHaveLength(3);

    const byPath = Object.fromEntries(results.map((r) => [r.filePath, r]));
    expect(byPath[good].valid).toBe(true);
    expect(byPath[alsoGood].valid).toBe(true);
    expect(byPath[bad].valid).toBe(false);
    expect(byPath[bad].foundKeys).toEqual(["playwright"]);
  });
});
