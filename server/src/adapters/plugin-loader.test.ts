import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression tests for issue #11530.

const mockAdapterPluginStore = vi.hoisted(() => ({
  listAdapterPlugins: vi.fn(),
  getAdapterPluginsDir: vi.fn(),
  getAdapterPluginByType: vi.fn(),
}));

vi.mock("../services/adapter-plugin-store.js", () => mockAdapterPluginStore);

let tmpDir: string;

function writeAdapterPackage(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-loader-test-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

beforeEach(() => {
  vi.resetModules();
  mockAdapterPluginStore.listAdapterPlugins.mockReturnValue([]);
  mockAdapterPluginStore.getAdapterPluginsDir.mockReturnValue("/tmp/paperclip-plugin-loader-test-store");
  mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue(undefined);
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getMultiFileReloadWarning", () => {
  it("returns undefined for a single-file adapter (reload is fully accurate)", async () => {
    tmpDir = writeAdapterPackage({
      "package.json": JSON.stringify({ name: "single-file-adapter", main: "index.js" }),
      "index.js": "export const createServerAdapter = () => ({ type: 'single_file_adapter' });\n",
    });
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue({
      type: "single_file_adapter",
      packageName: "single-file-adapter",
      localPath: tmpDir,
      installedAt: new Date(0).toISOString(),
    });

    const { getMultiFileReloadWarning } = await import("./plugin-loader.js");
    expect(getMultiFileReloadWarning("single_file_adapter")).toBeUndefined();
  });

  it("returns a warning when the entry point imports another local file", async () => {
    tmpDir = writeAdapterPackage({
      "package.json": JSON.stringify({ name: "multi-file-adapter", main: "index.js" }),
      "index.js":
        "import { greet } from './helper.js';\n" +
        "export const createServerAdapter = () => ({ type: 'multi_file_adapter', greet });\n",
      "helper.js": "export function greet() { return 'v1'; }\n",
    });
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue({
      type: "multi_file_adapter",
      packageName: "multi-file-adapter",
      localPath: tmpDir,
      installedAt: new Date(0).toISOString(),
    });

    const { getMultiFileReloadWarning } = await import("./plugin-loader.js");
    const warning = getMultiFileReloadWarning("multi_file_adapter");
    expect(warning).toBeDefined();
    expect(warning).toMatch(/fully restarted/);
  });

  it("returns a warning for a side-effect local import (no `from`)", async () => {
    tmpDir = writeAdapterPackage({
      "package.json": JSON.stringify({ name: "side-effect-adapter", main: "index.js" }),
      "index.js":
        "import './setup.js';\n" +
        "export const createServerAdapter = () => ({ type: 'side_effect_adapter' });\n",
      "setup.js": "// side-effect only\n",
    });
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue({
      type: "side_effect_adapter",
      packageName: "side-effect-adapter",
      localPath: tmpDir,
      installedAt: new Date(0).toISOString(),
    });

    const { getMultiFileReloadWarning } = await import("./plugin-loader.js");
    expect(getMultiFileReloadWarning("side_effect_adapter")).toBeDefined();
  });

  it("returns undefined for an unknown adapter type", async () => {
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue(undefined);
    const { getMultiFileReloadWarning } = await import("./plugin-loader.js");
    expect(getMultiFileReloadWarning("does_not_exist")).toBeUndefined();
  });
});

describe("reloadExternalAdapter (multi-file cache-bust limitation)", () => {
  it("keeps serving the stale sub-module after a reload — demonstrates the bug this PR documents", async () => {
    tmpDir = writeAdapterPackage({
      "package.json": JSON.stringify({ name: "repro-adapter", main: "index.js" }),
      "index.js":
        "import { greet } from './helper.js';\n" +
        "export const createServerAdapter = () => ({\n" +
        "  type: 'repro_adapter',\n" +
        "  async testEnvironment() { return { ok: true, message: greet() }; },\n" +
        "  async execute() { return { exitCode: 0, signal: null, timedOut: false }; },\n" +
        "});\n",
      "helper.js": "export function greet() { return 'v1'; }\n",
    });
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue({
      type: "repro_adapter",
      packageName: "repro-adapter",
      localPath: tmpDir,
      installedAt: new Date(0).toISOString(),
    });

    const { loadExternalAdapterPackage, reloadExternalAdapter, getMultiFileReloadWarning } =
      await import("./plugin-loader.js");

    const initial = await loadExternalAdapterPackage("repro-adapter", tmpDir);
    const initialResult = await initial.testEnvironment!({} as never);
    expect((initialResult as unknown as { message: string }).message).toBe("v1");

    // index.ts untouched — only the sub-module changes on disk.
    fs.writeFileSync(path.join(tmpDir, "helper.js"), "export function greet() { return 'v2'; }\n");

    const reloaded = await reloadExternalAdapter("repro_adapter");
    expect(reloaded).not.toBeNull();

    const reloadedResult = await reloaded!.testEnvironment!({} as never);

    // Bug: still 'v1' — reload doesn't cache-bust the sub-module.
    expect((reloadedResult as unknown as { message: string }).message).toBe("v1");
    expect(getMultiFileReloadWarning("repro_adapter")).toBeDefined();
  });
});
