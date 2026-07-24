import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chokidarMock = vi.hoisted(() => ({
  watch: vi.fn(),
}));

vi.mock("chokidar", () => ({
  default: chokidarMock,
}));

import { createPluginDevWatcher, resolvePluginWatchTargets } from "../services/plugin-dev-watcher.js";

const tempDirs: string[] = [];

beforeEach(() => {
  vi.useRealTimers();
  chokidarMock.watch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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

function writePluginPackage(pluginDir: string): void {
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
}

function createLifecycle() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    restartWorker: vi.fn().mockResolvedValue(undefined),
  });
}

function installMockFsWatcher() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const fakeWatcher = {
    close: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      handlers[event] = listener;
      return fakeWatcher;
    }),
  };
  chokidarMock.watch.mockReturnValue(fakeWatcher);
  return { fakeWatcher, handlers };
}

describe("resolvePluginWatchTargets", () => {
  it("watches package metadata plus concrete declared runtime files", () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);

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

describe("createPluginDevWatcher", () => {
  it("starts watching local plugins announced by lifecycle events", async () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    installMockFsWatcher();
    const lifecycle = createLifecycle();

    const devWatcher = createPluginDevWatcher(
      lifecycle as never,
      async (pluginId) => (pluginId === "plugin-1" ? pluginDir : null),
    );

    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1", pluginKey: "example" });

    await vi.waitFor(() => expect(chokidarMock.watch).toHaveBeenCalledTimes(1));
    const [watchedPaths] = chokidarMock.watch.mock.calls[0] ?? [];
    expect(watchedPaths).toContain(path.join(pluginDir, "dist", "worker.js"));

    devWatcher.close();
  });

  it("debounces watched file changes and restarts the plugin worker", async () => {
    vi.useFakeTimers();
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    const { handlers } = installMockFsWatcher();
    const lifecycle = createLifecycle();

    const devWatcher = createPluginDevWatcher(lifecycle as never);
    devWatcher.watch("plugin-1", pluginDir);

    handlers.all?.("change", path.join(pluginDir, "dist", "worker.js"));
    await vi.advanceTimersByTimeAsync(500);

    expect(lifecycle.restartWorker).toHaveBeenCalledWith("plugin-1");

    devWatcher.close();
  });
});
