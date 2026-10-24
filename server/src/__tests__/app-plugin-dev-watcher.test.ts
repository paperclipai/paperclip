import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppPluginDevWatcher } from "../app.js";
import type { PluginDevWatcher } from "../services/plugin-dev-watcher.js";

afterEach(() => vi.unstubAllEnvs());

describe("createAppPluginDevWatcher", () => {
  const lifecycle = {} as Parameters<typeof createAppPluginDevWatcher>[1];
  const resolvePackagePath = vi.fn(async () => null);

  it("does not create a watcher in production without opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAPERCLIP_PLUGIN_DEV_WATCH", "");
    const createWatcher = vi.fn();

    expect(createAppPluginDevWatcher("static", lifecycle, resolvePackagePath, createWatcher)).toBeNull();
    expect(createAppPluginDevWatcher("vite-dev", lifecycle, resolvePackagePath, createWatcher)).toBeNull();
    expect(createWatcher).not.toHaveBeenCalled();
  });

  it("starts a watcher for local Vite development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAPERCLIP_PLUGIN_DEV_WATCH", "");
    const watcher = {} as PluginDevWatcher;
    const createWatcher = vi.fn(() => watcher);

    expect(createAppPluginDevWatcher("vite-dev", lifecycle, resolvePackagePath, createWatcher)).toBe(watcher);
    expect(createWatcher).toHaveBeenCalledWith(lifecycle, resolvePackagePath);
    expect(createAppPluginDevWatcher("static", lifecycle, resolvePackagePath, createWatcher)).toBeNull();
    expect(createWatcher).toHaveBeenCalledTimes(1);
  });

  it("starts a watcher in production only with the explicit flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAPERCLIP_PLUGIN_DEV_WATCH", "1");
    const watcher = {} as PluginDevWatcher;
    const createWatcher = vi.fn(() => watcher);

    expect(createAppPluginDevWatcher("static", lifecycle, resolvePackagePath, createWatcher)).toBe(watcher);
    expect(createWatcher).toHaveBeenCalledWith(lifecycle, resolvePackagePath);
  });
});
