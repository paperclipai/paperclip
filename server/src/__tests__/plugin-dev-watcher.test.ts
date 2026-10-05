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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

  it("replaces the watcher when a loaded plugin moves to another local path", async () => {
    vi.useFakeTimers();
    const firstDir = makeTempPluginDir();
    const secondDir = makeTempPluginDir();
    writePluginPackage(firstDir);
    writePluginPackage(secondDir);
    const first = installMockFsWatcher();
    const lifecycle = createLifecycle();
    let packagePath = firstDir;
    const devWatcher = createPluginDevWatcher(lifecycle as never, async () => packagePath);
    devWatcher.watch("plugin-1", firstDir);
    first.handlers.all?.("change", path.join(firstDir, "dist", "worker.js"));

    const second = installMockFsWatcher();
    packagePath = secondDir;
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    await Promise.resolve();

    expect(first.fakeWatcher.close).toHaveBeenCalledTimes(1);
    expect(chokidarMock.watch).toHaveBeenCalledTimes(2);
    expect(chokidarMock.watch.mock.calls[1]?.[0]).toContain(path.join(secondDir, "dist", "worker.js"));
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.restartWorker).not.toHaveBeenCalled();

    // Closing a watcher is asynchronous. Late callbacks from the old watcher
    // must neither restart the worker nor close its replacement.
    first.handlers.all?.("change", path.join(firstDir, "dist", "worker.js"));
    first.handlers.error?.(new Error("old directory removed"));
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.restartWorker).not.toHaveBeenCalled();
    expect(second.fakeWatcher.close).not.toHaveBeenCalled();

    second.handlers.all?.("change", path.join(secondDir, "dist", "worker.js"));
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.restartWorker).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartWorker).toHaveBeenCalledWith("plugin-1");
    devWatcher.close();
    expect(second.fakeWatcher.close).toHaveBeenCalledTimes(1);
  });

  it("keeps one watcher for repeated registrations of the same resolved path", () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    const { fakeWatcher } = installMockFsWatcher();
    const devWatcher = createPluginDevWatcher(createLifecycle() as never);

    devWatcher.watch("plugin-1", pluginDir);
    devWatcher.watch("plugin-1", path.join(pluginDir, "dist", ".."));

    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    expect(fakeWatcher.close).not.toHaveBeenCalled();
    devWatcher.close();
  });

  it("stops watching the old path when the replacement directory is unavailable", async () => {
    vi.useFakeTimers();
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    const { fakeWatcher, handlers } = installMockFsWatcher();
    const lifecycle = createLifecycle();
    const devWatcher = createPluginDevWatcher(lifecycle as never);
    devWatcher.watch("plugin-1", pluginDir);
    handlers.all?.("change", path.join(pluginDir, "dist", "worker.js"));

    devWatcher.watch("plugin-1", path.join(pluginDir, "missing"));

    expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.restartWorker).not.toHaveBeenCalled();
    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    devWatcher.close();
  });

  it("stops watching a loaded plugin that no longer has a local package path", async () => {
    vi.useFakeTimers();
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    const { fakeWatcher, handlers } = installMockFsWatcher();
    const lifecycle = createLifecycle();
    const devWatcher = createPluginDevWatcher(lifecycle as never, async () => null);
    devWatcher.watch("plugin-1", pluginDir);
    handlers.all?.("change", path.join(pluginDir, "dist", "worker.js"));

    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    await Promise.resolve();

    expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.restartWorker).not.toHaveBeenCalled();
    devWatcher.close();
  });

  it.each(["new path", "no local path"])("ignores an older path lookup after a newer %s registration", async (replacement) => {
    const firstDir = makeTempPluginDir();
    const secondDir = makeTempPluginDir();
    writePluginPackage(firstDir);
    writePluginPackage(secondDir);
    const first = installMockFsWatcher();
    const lifecycle = createLifecycle();
    const oldLookup = deferred<string | null>();
    const newLookup = deferred<string | null>();
    const resolver = vi.fn().mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(newLookup.promise);
    const devWatcher = createPluginDevWatcher(lifecycle as never, resolver);
    devWatcher.watch("plugin-1", firstDir);

    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    const second = installMockFsWatcher();
    newLookup.resolve(replacement === "new path" ? secondDir : null);
    await Promise.resolve();
    expect(first.fakeWatcher.close).toHaveBeenCalledTimes(1);
    const expectedWatchCount = replacement === "new path" ? 2 : 1;
    expect(chokidarMock.watch).toHaveBeenCalledTimes(expectedWatchCount);

    oldLookup.resolve(firstDir);
    await Promise.resolve();

    expect(chokidarMock.watch).toHaveBeenCalledTimes(expectedWatchCount);
    expect(second.fakeWatcher.close).not.toHaveBeenCalled();
    devWatcher.close();
  });

  it.each(["watch", "unwatch", "close"])("invalidates pending path lookups on a manual %s", async (action) => {
    const firstDir = makeTempPluginDir();
    const secondDir = makeTempPluginDir();
    writePluginPackage(firstDir);
    writePluginPackage(secondDir);
    installMockFsWatcher();
    const lifecycle = createLifecycle();
    const lookup = deferred<string | null>();
    const devWatcher = createPluginDevWatcher(lifecycle as never, () => lookup.promise);
    if (action !== "close") devWatcher.watch("plugin-1", firstDir);
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });

    if (action === "watch") devWatcher.watch("plugin-1", firstDir);
    if (action === "unwatch") devWatcher.unwatch("plugin-1");
    if (action === "close") devWatcher.close();
    lookup.resolve(secondDir);
    await Promise.resolve();
    await Promise.resolve();

    expect(chokidarMock.watch).toHaveBeenCalledTimes(action === "close" ? 0 : 1);
    devWatcher.close();
  });

  it("does not reuse a pending lookup identity after unwatching", async () => {
    const pluginDir = makeTempPluginDir();
    writePluginPackage(pluginDir);
    installMockFsWatcher();
    const lifecycle = createLifecycle();
    const oldLookup = deferred<string | null>();
    const newLookup = deferred<string | null>();
    const resolver = vi.fn().mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(newLookup.promise);
    const devWatcher = createPluginDevWatcher(lifecycle as never, resolver);
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    devWatcher.unwatch("plugin-1");
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });

    oldLookup.resolve(pluginDir);
    await Promise.resolve();
    expect(chokidarMock.watch).not.toHaveBeenCalled();
    newLookup.resolve(pluginDir);
    await Promise.resolve();
    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    devWatcher.close();
  });
});
