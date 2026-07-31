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
let findActiveServerAdapter: typeof import("../adapters/registry.js").findActiveServerAdapter;
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
    findActiveServerAdapter = registry.findActiveServerAdapter;
    setOverridePaused = registry.setOverridePaused;
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("hermes_local");
    unregisterServerAdapter("claude_local");
    registerServerAdapter(overridingConfigSchemaAdapter);
  });

  afterEach(() => {
    setOverridePaused("claude_local", false);
    unregisterServerAdapter("hermes_local");
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
      expect(typeof adapter.capabilities.supportsAcp).toBe("boolean");
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
      supportsAcp: true,
    });
    expect(codexLocal.acp).toMatchObject({
      agentId: "codex",
      skillsMode: "ephemeral",
      prerequisites: {
        nodeRange: ">=22.13.0",
        packages: ["@agentclientprotocol/codex-acp"],
      },
    });

    // process adapter should have no local capabilities
    const processAdapter = res.body.find((a: any) => a.type === "process");
    expect(processAdapter).toBeDefined();
    expect(processAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      supportsAcp: false,
    });

    // cursor adapter should require materialized runtime skills
    const cursorAdapter = res.body.find((a: any) => a.type === "cursor");
    expect(cursorAdapter).toBeDefined();
    expect(cursorAdapter.capabilities.requiresMaterializedRuntimeSkills).toBe(true);
    expect(cursorAdapter.capabilities.supportsInstructionsBundle).toBe(true);
    expect(cursorAdapter.capabilities.supportsAcp).toBe(false);

    const geminiAdapter = res.body.find((a: any) => a.type === "gemini_local");
    expect(geminiAdapter).toBeDefined();
    expect(geminiAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: true,
      supportsAcp: true,
    });
    expect(geminiAdapter.acp).toMatchObject({
      agentId: "gemini",
      skillsMode: "ephemeral",
      prerequisites: {
        nodeRange: ">=20.0.0",
        packages: ["@google/gemini-cli"],
      },
    });

    const grokAdapter = res.body.find((a: any) => a.type === "grok_local");
    expect(grokAdapter).toBeDefined();
    expect(grokAdapter.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: true,
      supportsAcp: false,
    });

    const hermesLocal = res.body.find((a: any) => a.type === "hermes_local");
    expect(hermesLocal).toBeDefined();
    expect(hermesLocal.source).toBe("builtin");
    expect(hermesLocal.capabilities).toMatchObject({
      supportsInstructionsBundle: true,
      supportsSkills: true,
      supportsLocalAgentJwt: true,
      requiresMaterializedRuntimeSkills: false,
      supportsAcp: false,
    });

    const hermesGateway = res.body.find((a: any) => a.type === "hermes_gateway");
    expect(hermesGateway).toBeDefined();
    expect(hermesGateway.source).toBe("builtin");
    expect(hermesGateway.capabilities).toMatchObject({
      supportsInstructionsBundle: false,
      supportsSkills: false,
      supportsLocalAgentJwt: false,
      requiresMaterializedRuntimeSkills: false,
      supportsAcp: false,
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

    // acpx_local remains registered only as a tombstone for legacy rows.
    const acpxLocal = res.body.find((a: any) => a.type === "acpx_local");
    expect(acpxLocal).toBeDefined();
    expect(acpxLocal.capabilities.supportsSkills).toBe(false);
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

  it("serves an empty tombstone config schema for retired acpx_local", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters/acpx_local/config-schema");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toEqual([]);
  });

  it("serves the built-in claude_local ACP engine config schema", async () => {
    const app = createApp();

    const paused = await request(app)
      .patch("/api/adapters/claude_local/override")
      .send({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    const res = await request(app).get("/api/adapters/claude_local/config-schema");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "engine",
          default: "auto",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "auto" }),
            expect.objectContaining({ value: "cli" }),
            expect.objectContaining({ value: "acp" }),
          ]),
        }),
        expect.objectContaining({
          key: "agentCommand",
          meta: { visibleWhen: { key: "engine", values: ["acp"] } },
        }),
        expect.objectContaining({
          key: "warmHandleIdleMs",
          default: 0,
        }),
      ]),
    );
  });

  it("serves the built-in codex_local ACP engine config schema", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters/codex_local/config-schema");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "engine",
          default: "auto",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "auto" }),
            expect.objectContaining({ value: "cli" }),
            expect.objectContaining({ value: "acp" }),
          ]),
        }),
        expect.objectContaining({
          key: "agentCommand",
          meta: { visibleWhen: { key: "engine", values: ["acp"] } },
        }),
        expect.objectContaining({
          key: "warmHandleIdleMs",
          default: 0,
        }),
      ]),
    );
  });

  it("serves the built-in gemini_local ACP engine config schema", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters/gemini_local/config-schema");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "engine",
          default: "auto",
          options: expect.arrayContaining([
            expect.objectContaining({ value: "auto" }),
            expect.objectContaining({ value: "cli" }),
            expect.objectContaining({ value: "acp" }),
          ]),
        }),
        expect.objectContaining({
          key: "agentCommand",
          meta: { visibleWhen: { key: "engine", values: ["acp"] } },
        }),
        expect.objectContaining({
          key: "warmHandleIdleMs",
          default: 0,
        }),
      ]),
    );
  });

  it("serves built-in Hermes config schemas", async () => {
    const app = createApp();

    const local = await request(app).get("/api/adapters/hermes_local/config-schema");
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    expect(local.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "provider" }),
        expect.objectContaining({ key: "timeoutSec" }),
      ]),
    );

    const gateway = await request(app).get("/api/adapters/hermes_gateway/config-schema");
    expect(gateway.status, JSON.stringify(gateway.body)).toBe(200);
    expect(gateway.body.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "apiBaseUrl", required: true }),
        expect.objectContaining({ key: "apiKey", required: true }),
      ]),
    );
  });

  it("GET /api/adapters lists acpx_local only as a model-less tombstone", async () => {
    const app = createApp();

    const res = await request(app).get("/api/adapters");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acpxLocal = res.body.find((a: any) => a.type === "acpx_local");
    expect(acpxLocal).toBeDefined();
    expect(acpxLocal.modelsCount).toBe(0);
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

  it("POST /api/adapters/install allows an external adapter to override a builtin type", async () => {
    const builtin = findServerAdapter("codex_local");
    expect(builtin).not.toBeNull();

    const externalModule: ServerAdapterModule = {
      type: "codex_local",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "codex_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      models: [{ id: "plugin-codex", label: "Plugin Codex" }],
    };
    mockPluginLoader.loadExternalAdapterPackage.mockResolvedValue(externalModule);

    const app = createApp({ isInstanceAdmin: true });
    const res = await request(app)
      .post("/api/adapters/install")
      .send({ packageName: "/tmp/fake-codex-override", isLocalPath: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe("codex_local");
    const registeredOverride = findServerAdapter("codex_local");
    expect(registeredOverride).toMatchObject({
      type: "codex_local",
      models: [{ id: "plugin-codex", label: "Plugin Codex" }],
    });

    setOverridePaused("codex_local", true);
    expect(findActiveServerAdapter("codex_local")).toBe(builtin);

    mockAdapterPluginStore.getAdapterPluginByType.mockReturnValue({
      type: "codex_local",
      packageName: undefined,
      localPath: "/tmp/fake-codex-override",
      installedAt: new Date(0).toISOString(),
    });
    mockAdapterPluginStore.removeAdapterPlugin.mockReturnValue(true);

    const removed = await request(app).delete("/api/adapters/codex_local");
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toMatchObject({ type: "codex_local", removed: true });

    unregisterServerAdapter("codex_local");
    expect(findServerAdapter("codex_local")).toBe(builtin);
    setOverridePaused("codex_local", false);
  });
});
