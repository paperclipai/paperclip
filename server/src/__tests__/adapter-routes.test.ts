import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAdapterPluginStore = vi.hoisted(() => ({
  listAdapterPlugins: vi.fn(),
  addAdapterPlugin: vi.fn(),
  removeAdapterPlugin: vi.fn(),
  getAdapterPluginByType: vi.fn(),
  getAdapterPluginsDir: vi.fn(),
  getDisabledAdapterTypes: vi.fn(),
  setAdapterDisabled: vi.fn(),
}));

const mockPluginLoader = vi.hoisted(() => ({
  buildExternalAdapters: vi.fn(),
  loadExternalAdapterPackage: vi.fn(),
  getUiParserSource: vi.fn(),
  getOrExtractUiParserSource: vi.fn(),
  reloadExternalAdapter: vi.fn(),
}));

const overridingConfigSchemaAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_local",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
  getConfigSchema: async () => ({
    version: 1,
    fields: [
      {
        key: "mode",
        type: "text",
        label: "Mode",
      },
    ],
  }),
};

let registerServerAdapter: typeof import("../adapters/registry.js").registerServerAdapter;
let unregisterServerAdapter: typeof import("../adapters/registry.js").unregisterServerAdapter;
let findServerAdapter: typeof import("../adapters/registry.js").findServerAdapter;
let setOverridePaused: typeof import("../adapters/registry.js").setOverridePaused;
let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;

function registerModuleMocks() {
  vi.doMock("node:child_process", async () => vi.importActual("node:child_process"));
  vi.doMock("../adapters/plugin-loader.js", () => mockPluginLoader);
  vi.doMock("../services/adapter-plugin-store.js", () => mockAdapterPluginStore);
  vi.doMock("../routes/adapters.js", async () => vi.importActual("../routes/adapters.js"));
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../middleware/index.js", async () => vi.importActual("../middleware/index.js"));
}

function createApp(actorOverrides: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [],
      source: "local_implicit",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

describe("adapter routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../adapters/registry.js");
    vi.doUnmock("../adapters/plugin-loader.js");
    vi.doUnmock("../services/adapter-plugin-store.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    mockAdapterPluginStore.listAdapterPlugins.mockReturnValue([]);
    mockAdapterPluginStore.addAdapterPlugin.mockResolvedValue(undefined);
    mockAdapterPluginStore.removeAdapterPlugin.mockReturnValue(false);
    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue(undefined);
    mockAdapterPluginStore.getAdapterPluginsDir.mockReturnValue("/tmp/paperclip-adapter-routes-test");
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([]);
    mockAdapterPluginStore.setAdapterDisabled.mockReturnValue(false);
    mockPluginLoader.buildExternalAdapters.mockResolvedValue([]);
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue(null);
    mockPluginLoader.getUiParserSource.mockResolvedValue(null);
    mockPluginLoader.getOrExtractUiParserSource.mockResolvedValue(null);
    mockPluginLoader.reloadExternalAdapter.mockResolvedValue(null);
    const [registry, routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../adapters/registry.js")>("../adapters/registry.js"),
      import("../routes/adapters.js"),
      import("../middleware/index.js"),
    ]);
    registerServerAdapter = registry.registerServerAdapter;
    unregisterServerAdapter = registry.unregisterServerAdapter;
    findServerAdapter = registry.findServerAdapter;
    setOverridePaused = registry.setOverridePaused;
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
    registerServerAdapter(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("claude_local");
  });

  it("GET /api/adapters includes capabilities object for each adapter", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);
    const adapters = Array.isArray(res.body) ? res.body : JSON.parse(res.text);
    expect(Array.isArray(adapters)).toBe(true);
    expect(adapters.length).toBeGreaterThan(0);

    // Every adapter should have a capabilities object
    for (const adapter of adapters) {
      expect(adapter.capabilities).toBeDefined();
      expect(typeof adapter.capabilities.supportsInstructionsBundle).toBe("boolean");
      expect(typeof adapter.capabilities.supportsSkills).toBe("boolean");
      expect(typeof adapter.capabilities.supportsLocalAgentJwt).toBe("boolean");
      expect(typeof adapter.capabilities.requiresMaterializedRuntimeSkills).toBe("boolean");
    }
  });

  it("GET /api/adapters returns correct capabilities for built-in adapters", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // codex_local has instructions bundle + skills + jwt, no materialized skills
    // (claude_local is overridden by beforeEach, so check codex_local instead)
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
    });

    // process adapter should have no local capabilities
    const processAdapter = res.body.find((a: any) => a.type === "process");
    expect(processAdapter).toBeDefined();
    expect(processAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
    });

    // cursor adapter should require materialized runtime skills
    const cursorAdapter = res.body.find((a: any) => a.type === "cursor");
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.capabilities.requiresMaterializedRuntimeSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsInstructionsBundle).toBe(true);

    // hermes_local currently supports skills + local JWT, but not the managed
    // instructions bundle flow because the bundled adapter does not consume
    // instructionsFilePath at runtime.
    const hermesAdapter = res.body.find((a: any) => a.type === "hermes_local");
    expect(hermesAdapter).toBeDefined();
    expect(hermesAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
    });
  });

  it("GET /api/adapters derives supportsSkills from listSkills/syncSkills presence", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");
    expect(res.status).toBe(200);

    // http adapter has no listSkills/syncSkills
    const httpAdapter = res.body.find((a: any) => a.type === "http");
    expect(httpAdapter).toBeDefined();
    expect(httpAdapter.capabilities.supportsSkills).toBe(false);

    // codex_local has listSkills/syncSkills
    const codexLocal = res.body.find((a: any) => a.type === "codex_local");
    expect(codexLocal).toBeDefined();
    expect(codexLocal.capabilities.supportsSkills).toBe(true);
  });

  it("uses the active adapter when resolving config schema for a paused builtin override", async () => {
    const app = createApp();

    const active = await request(app).get("/api/adapters/claude_local/config-schema");
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body).toMatchObject({
      fields: [{ key: "mode" }],
    });

    const paused = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const builtin = await request(app).get("/api/adapters/claude_local/config-schema");
    expect([200, 404], JSON.stringify(builtin.body)).toContain(builtin.status);
    expect(builtin.body).not.toMatchObject({
      fields: [{ key: "mode" }],
    });
  });

  it("rejects signed-in users without org access", async () => {
    const app = createApp({
      userId: "outsider-1",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/adapters/claude_local/config-schema");

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("POST /api/adapters/install preserves module-provided sessionManagement (hot-install parity with init-time IIFE)", async () => {
    const HOT_INSTALL_TYPE = "hot_install_session_test";
    const declaredSessionManagement = {
      supportsSessionResume: true,
      nativeContextManagement: "confirmed" as const,
      defaultSessionCompaction: {
        enabled: true,
        maxSessionRuns: 10,
        maxRawInputTokens: 100_000,
        maxSessionAgeHours: 24,
      },
    };
    const externalModule: ServerAdapterModule = {
      type: HOT_INSTALL_TYPE,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: HOT_INSTALL_TYPE,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      sessionManagement: declaredSessionManagement,
    };
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue(externalModule);

    const app = createApp({ isInstanceAdmin: true });
    const res = await request(app)
      .post("/api/adapters/install")
      .send({ packageName: "/tmp/fake-hot-install-adapter", isLocalPath: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe(HOT_INSTALL_TYPE);

    const registered = findServerAdapter(HOT_INSTALL_TYPE);
    expect(registered).not.toBeNull();
    expect(registered?.sessionManagement).toEqual(declaredSessionManagement);

    unregisterServerAdapter(HOT_INSTALL_TYPE);
  });
});
