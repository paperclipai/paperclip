import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVersionedModuleImportUrl } from "../services/plugin-loader.js";

const tempDirs: string[] = [];

async function makeTempPluginDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

function manifestSource(version: string): string {
  return `export default {
  id: "paperclip-test-plugin",
  apiVersion: 1,
  version: ${JSON.stringify(version)},
  displayName: "Test Plugin",
  description: "A test plugin",
  author: "Paperclip Tests",
  categories: ["connector"],
  capabilities: [],
  entrypoints: {
    worker: "./dist/worker.js"
  }
};\n`;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin-loader manifest imports", () => {
  it("busts the module cache when dist/manifest.js changes on disk", async () => {
    const pluginDir = await makeTempPluginDir();
    const distDir = path.join(pluginDir, "dist");
    const manifestPath = path.join(distDir, "manifest.js");

    await mkdir(distDir, { recursive: true });
    await writeFile(manifestPath, manifestSource("0.1.0"));

    const firstUrl = await resolveVersionedModuleImportUrl(manifestPath);
    const firstModule = await import(firstUrl);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(manifestPath, manifestSource("0.2.0"));

    const secondUrl = await resolveVersionedModuleImportUrl(manifestPath);
    const secondModule = await import(secondUrl);

    expect(firstUrl).not.toBe(secondUrl);
    expect((firstModule.default as { version: string }).version).toBe("0.1.0");
    expect((secondModule.default as { version: string }).version).toBe("0.2.0");
  });
});
