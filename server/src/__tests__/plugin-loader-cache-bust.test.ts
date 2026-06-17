import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it } from "vitest";
import { pluginLoader } from "../services/plugin-loader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createPluginPackage(): Promise<string> {
  const packageDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-cache-bust-"));
  tempDirs.push(packageDir);

  await mkdir(path.join(packageDir, "dist"));
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "paperclip-plugin-cache-bust-test",
      version: "0.1.0",
      type: "module",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
      },
    }),
    "utf8",
  );
  await writeManifest(packageDir, "First manifest text");
  return packageDir;
}

async function writeManifest(packageDir: string, description: string): Promise<void> {
  await writeFile(
    path.join(packageDir, "dist", "manifest.js"),
    `export default ${JSON.stringify({
      id: "paperclipai.plugin-cache-bust-test",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Cache Bust Test",
      description,
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["issues.read"],
      entrypoints: {
        worker: "./dist/worker.js",
      },
    })};\n`,
    "utf8",
  );
}

describe("pluginLoader manifest imports", () => {
  it("reloads manifest text from disk for the same manifest path", async () => {
    const packageDir = await createPluginPackage();
    const loader = pluginLoader({} as Db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    });

    await expect(loader.loadManifest(packageDir)).resolves.toMatchObject({
      description: "First manifest text",
    });

    await writeManifest(packageDir, "Second manifest text");

    await expect(loader.loadManifest(packageDir)).resolves.toMatchObject({
      description: "Second manifest text",
    });
  });
});
