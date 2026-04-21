import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const records = vi.hoisted(() => ({ items: [] as Array<Record<string, unknown>> }));
const mockLoadExternalAdapterPackage = vi.hoisted(() => vi.fn());
const mockBuildExternalAdapters = vi.hoisted(() => vi.fn(async () => []));
const mockAddAdapterPlugin = vi.hoisted(() =>
  vi.fn((record: Record<string, unknown>) => {
    const existingIndex = records.items.findIndex((item) => item.type === record.type);
    if (existingIndex >= 0) records.items.splice(existingIndex, 1, record);
    else records.items.push(record);
  }),
);

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  const pluginLoaderMock = () => ({
    buildExternalAdapters: mockBuildExternalAdapters,
    loadExternalAdapterPackage: mockLoadExternalAdapterPackage,
    getUiParserSource: vi.fn(() => undefined),
    getOrExtractUiParserSource: vi.fn(() => undefined),
    reloadExternalAdapter: vi.fn(async () => null),
  });
  vi.doMock("../adapters/plugin-loader.js", pluginLoaderMock);
  vi.doMock("../adapters/plugin-loader.ts", pluginLoaderMock);

  const adapterPluginStoreMock = () => ({
    listAdapterPlugins: vi.fn(() => records.items),
    addAdapterPlugin: mockAddAdapterPlugin,
    removeAdapterPlugin: vi.fn((type: string) => {
      records.items = records.items.filter((item) => item.type !== type);
    }),
    getAdapterPluginByType: vi.fn((type: string) => records.items.find((item) => item.type === type)),
    getAdapterPluginsDir: vi.fn(() => "/tmp/paperclip-adapter-plugins-test"),
    getDisabledAdapterTypes: vi.fn(() => []),
    setAdapterDisabled: vi.fn(() => true),
  });
  vi.doMock("../services/adapter-plugin-store.js", adapterPluginStoreMock);
  vi.doMock("../services/adapter-plugin-store.ts", adapterPluginStoreMock);
}

function resetAdapterRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/adapter-utils");
  vi.doUnmock("../adapters/plugin-loader.js");
  vi.doUnmock("../adapters/plugin-loader.ts");
  vi.doUnmock("../services/adapter-plugin-store.js");
  vi.doUnmock("../services/adapter-plugin-store.ts");
  vi.doUnmock("../routes/adapters.js");
  vi.doUnmock("../routes/adapters.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
let adapterRouteImportSeq = 0;

const hermesExternalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "hermes_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  models: [{ id: "hermes-test-model", label: "Hermes Test Model" }],
  supportsLocalAgentJwt: true,
  agentConfigurationDoc: "Hermes external adapter test fixture",
  sessionCodec: {
    deserialize: (raw) => (raw && typeof raw === "object" ? raw as Record<string, unknown> : null),
    serialize: (params) => params,
  },
  detectModel: async () => ({
    model: "hermes-test-model",
    provider: "test",
    source: "test-fixture",
  }),
};

async function createApp() {
  resetAdapterRouteModules();
  registerModuleMocks();
  adapterRouteImportSeq += 1;
  const routeModulePath = `../routes/adapters.ts?hermes-external-adapter-routes-${adapterRouteImportSeq}`;
  const [{ adapterRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/adapters.ts")>,
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

describe("Hermes external adapter loading", () => {
  beforeEach(async () => {
    resetAdapterRouteModules();
    registerModuleMocks();
    vi.clearAllMocks();
    records.items = [];
    mockLoadExternalAdapterPackage.mockResolvedValue(hermesExternalAdapter);
    const { unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("hermes_local");
  });

  afterEach(async () => {
    resetAdapterRouteModules();
    records.items = [];
    const { unregisterServerAdapter } = await import("../adapters/index.js");
    unregisterServerAdapter("hermes_local");
    vi.resetAllMocks();
  });

  it("installs hermes_local through Adapter Manager as an external adapter with run-scoped auth support", async () => {
    const packageDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-external-"));
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@henkey/hermes-paperclip-adapter", version: "0.3.0" }),
      "utf8",
    );

    try {
      const res = await request(await createApp())
        .post("/api/adapters/install")
        .send({ packageName: packageDir, isLocalPath: true });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({
        type: "hermes_local",
        version: "0.3.0",
      });
      expect(mockLoadExternalAdapterPackage).toHaveBeenCalledWith(packageDir, path.resolve(packageDir));
      expect(mockAddAdapterPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "hermes_local",
          localPath: path.resolve(packageDir),
        }),
      );

      const { findServerAdapter } = await import("../adapters/index.js");
      expect(findServerAdapter("hermes_local")).toMatchObject({
        type: "hermes_local",
        supportsLocalAgentJwt: true,
      });
    } finally {
      await fs.rm(packageDir, { recursive: true, force: true });
    }
  });

  it("keeps Hermes out of Paperclip core registrations and direct package dependencies", async () => {
    const [{ BUILTIN_ADAPTER_TYPES }, serverRegistry, uiRegistry, serverPackage, uiPackage] = await Promise.all([
      import("../adapters/builtin-adapter-types.js"),
      fs.readFile(path.join(repoRoot, "server/src/adapters/registry.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "ui/src/adapters/registry.ts"), "utf8"),
      fs.readFile(path.join(repoRoot, "server/package.json"), "utf8"),
      fs.readFile(path.join(repoRoot, "ui/package.json"), "utf8"),
    ]);

    expect(BUILTIN_ADAPTER_TYPES.has("hermes_local")).toBe(false);
    expect(serverRegistry).not.toContain("hermes-paperclip-adapter");
    expect(uiRegistry).not.toContain("hermes-paperclip-adapter");
    expect(serverPackage).not.toContain("hermes-paperclip-adapter");
    expect(uiPackage).not.toContain("hermes-paperclip-adapter");
  });
});
