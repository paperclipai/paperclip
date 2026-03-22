import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginWatchTargets } from "../services/plugin-dev-watcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-watch-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolvePluginWatchTargets", () => {
  it("watches package metadata plus concrete declared runtime files", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "ui"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        paperclipPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
          ui: "./dist/ui",
        },
      }),
    );
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "worker.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.css"), "body {}\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.css"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "worker.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
    ]);
  });

  it("falls back to dist when package metadata does not declare entrypoints", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "nested"), { recursive: true });
    writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/example" }));
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "nested", "chunk.js"), "export default {};\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "nested", "chunk.js"), recursive: false, kind: "file" },
    ]);
  });
});
