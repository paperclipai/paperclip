import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfigMock,
  listAdapterPluginsMock,
  getAdapterPluginsDirMock,
  getAdapterPluginByTypeMock,
  loggerMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  listAdapterPluginsMock: vi.fn(),
  getAdapterPluginsDirMock: vi.fn(),
  getAdapterPluginByTypeMock: vi.fn(),
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: listAdapterPluginsMock,
  getAdapterPluginsDir: getAdapterPluginsDirMock,
  getAdapterPluginByType: getAdapterPluginByTypeMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: loggerMock,
}));

async function writeAdapterPackage(
  packageDir: string,
  packageName: string,
  moduleSource: string,
): Promise<void> {
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.2.3",
      type: "module",
      exports: {
        ".": "./index.js",
      },
    }, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(packageDir, "index.js"), moduleSource, "utf8");
}

describe("adapter plugin loader", () => {
  let rootDir: string;
  let discoveryDir: string;

  beforeEach(async () => {
    vi.resetModules();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-loader-"));
    discoveryDir = path.join(rootDir, "discovered");
    await fs.mkdir(discoveryDir, { recursive: true });

    loadConfigMock.mockReturnValue({ adapterPluginsDir: discoveryDir });
    listAdapterPluginsMock.mockReturnValue([]);
    getAdapterPluginsDirMock.mockReturnValue(path.join(rootDir, "managed"));
    getAdapterPluginByTypeMock.mockReturnValue(undefined);
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("loads valid adapters from the configured discovery directory and skips invalid packages", async () => {
    await writeAdapterPackage(
      path.join(discoveryDir, "valid-adapter"),
      "valid-adapter",
      `export function createServerAdapter() {
        return {
          type: "directory_test",
          execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
          testEnvironment: async () => ({
            adapterType: "directory_test",
            status: "pass",
            checks: [],
            testedAt: new Date(0).toISOString(),
          }),
          models: [],
          supportsLocalAgentJwt: false,
        };
      }`,
    );

    await writeAdapterPackage(
      path.join(discoveryDir, "broken-adapter"),
      "broken-adapter",
      `export const notAnAdapter = true;`,
    );

    const {
      buildExternalAdapters,
      listRuntimeDiscoveredAdapterRecords,
    } = await import("../adapters/plugin-loader.js");

    const adapters = await buildExternalAdapters();

    expect(adapters.map((adapter) => adapter.type)).toEqual(["directory_test"]);
    expect(listRuntimeDiscoveredAdapterRecords()).toEqual([
      expect.objectContaining({
        packageName: "valid-adapter",
        localPath: path.join(discoveryDir, "valid-adapter"),
        type: "directory_test",
        version: "1.2.3",
      }),
    ]);
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
