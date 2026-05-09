import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mocks = vi.hoisted(() => {
  const externalRecords = new Map<string, any>();

  return {
    externalRecords,
    execFile: vi.fn((_file: string, _args: string[], optionsOrCallback: unknown, maybeCallback?: unknown) => {
      const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      if (typeof callback === "function") {
        callback(null, "", "");
      }
      return {
        kill: vi.fn(),
        on: vi.fn(),
      };
    }),
    listAdapterPlugins: vi.fn(),
    addAdapterPlugin: vi.fn((record: any) => {
      externalRecords.set(record.type, record);
    }),
    removeAdapterPlugin: vi.fn((type: string) => {
      externalRecords.delete(type);
    }),
    getAdapterPluginByType: vi.fn((type: string) => externalRecords.get(type)),
    getAdapterPluginsDir: vi.fn(),
    getDisabledAdapterTypes: vi.fn(),
    setAdapterDisabled: vi.fn(),
    loadExternalAdapterPackage: vi.fn(),
    buildExternalAdapters: vi.fn(async () => []),
    reloadExternalAdapter: vi.fn(),
    getUiParserSource: vi.fn(),
    getOrExtractUiParserSource: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: mocks.execFile,
}));

vi.mock("../services/adapter-plugin-store.js", () => ({
  listAdapterPlugins: mocks.listAdapterPlugins,
  addAdapterPlugin: mocks.addAdapterPlugin,
  removeAdapterPlugin: mocks.removeAdapterPlugin,
  getAdapterPluginByType: mocks.getAdapterPluginByType,
  getAdapterPluginsDir: mocks.getAdapterPluginsDir,
  getDisabledAdapterTypes: mocks.getDisabledAdapterTypes,
  setAdapterDisabled: mocks.setAdapterDisabled,
}));

vi.mock("../adapters/plugin-loader.js", () => ({
  buildExternalAdapters: mocks.buildExternalAdapters,
  loadExternalAdapterPackage: mocks.loadExternalAdapterPackage,
  getUiParserSource: mocks.getUiParserSource,
  getOrExtractUiParserSource: mocks.getOrExtractUiParserSource,
  reloadExternalAdapter: mocks.reloadExternalAdapter,
}));

function registerRouteMocks() {
  vi.doMock("node:child_process", () => ({
    execFile: mocks.execFile,
  }));

  vi.doMock("../services/adapter-plugin-store.js", () => ({
    listAdapterPlugins: mocks.listAdapterPlugins,
    addAdapterPlugin: mocks.addAdapterPlugin,
    removeAdapterPlugin: mocks.removeAdapterPlugin,
    getAdapterPluginByType: mocks.getAdapterPluginByType,
    getAdapterPluginsDir: mocks.getAdapterPluginsDir,
    getDisabledAdapterTypes: mocks.getDisabledAdapterTypes,
    setAdapterDisabled: mocks.setAdapterDisabled,
  }));

  vi.doMock("../adapters/plugin-loader.js", () => ({
    buildExternalAdapters: mocks.buildExternalAdapters,
    loadExternalAdapterPackage: mocks.loadExternalAdapterPackage,
    getUiParserSource: mocks.getUiParserSource,
    getOrExtractUiParserSource: mocks.getOrExtractUiParserSource,
    reloadExternalAdapter: mocks.reloadExternalAdapter,
  }));
}

const EXTERNAL_ADAPTER_TYPE = "external_admin_test";
const EXTERNAL_PACKAGE_NAME = "paperclip-external-adapter";
let adapterRoutes: typeof import("../routes/adapters.js").adapterRoutes;
let errorHandler: typeof import("../middleware/index.js").errorHandler;
let registerServerAdapter: typeof import("../adapters/registry.js").registerServerAdapter;
let unregisterServerAdapter: typeof import("../adapters/registry.js").unregisterServerAdapter;
let setOverridePaused: typeof import("../adapters/registry.js").setOverridePaused;

function createAdapter(type = EXTERNAL_ADAPTER_TYPE): ServerAdapterModule {
  return {
    type,
    models: [],
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({
      adapterType: type,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
  };
}

function installedRecord(type = EXTERNAL_ADAPTER_TYPE) {
  return {
    packageName: EXTERNAL_PACKAGE_NAME,
    type,
    installedAt: new Date(0).toISOString(),
  };
}

function createApp(actor: Express.Request["actor"]) {
  if (!adapterRoutes || !errorHandler) {
    throw new Error("adapter route test dependencies were not loaded");
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      memberships: Array.isArray(actor.memberships)
        ? actor.memberships.map((membership) => ({ ...membership }))
        : actor.memberships,
    } as Express.Request["actor"];
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function boardMember(membershipRole: "admin" | "operator" | "viewer"): Express.Request["actor"] {
  return {
    type: "board",
    userId: `${membershipRole}-user`,
    userName: null,
    userEmail: null,
    source: "session",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [
      {
        companyId: "company-1",
        membershipRole,
        status: "active",
      },
    ],
  };
}

const instanceAdmin: Express.Request["actor"] = {
  type: "board",
  userId: "instance-admin",
  userName: null,
  userEmail: null,
  source: "session",
  isInstanceAdmin: true,
  companyIds: [],
  memberships: [],
};

function sendMutatingRequest(app: express.Express, name: string) {
  switch (name) {
    case "install":
      return requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/adapters/install")
          .send({ packageName: EXTERNAL_PACKAGE_NAME }),
      );
    case "disable":
      return requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`)
          .send({ disabled: true }),
      );
    case "override":
      return requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch("/api/adapters/claude_local/override")
          .send({ paused: true }),
      );
    case "delete":
      return requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`));
    case "reload":
      return requestApp(app, (baseUrl) => request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`));
    case "reinstall":
      return requestApp(app, (baseUrl) => request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reinstall`));
    default:
      throw new Error(`Unknown mutating adapter route: ${name}`);
  }
}

function seedInstalledExternalAdapter() {
  mocks.externalRecords.set(EXTERNAL_ADAPTER_TYPE, installedRecord());
  unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
  registerServerAdapter(createAdapter());
}

function resetInstalledExternalAdapterState() {
  mocks.externalRecords.clear();
  unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
  setOverridePaused("claude_local", false);
}

describe.sequential("adapter management route authorization", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
    vi.doUnmock("../services/adapter-plugin-store.js");
    vi.doUnmock("../adapters/plugin-loader.js");
    vi.doUnmock("../routes/adapters.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../adapters/registry.js");
    registerRouteMocks();
    vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

    const [routes, middleware, registry] = await Promise.all([
      vi.importActual<typeof import("../routes/adapters.js")>("../routes/adapters.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../adapters/registry.js")>("../adapters/registry.js"),
    ]);
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
    registerServerAdapter = registry.registerServerAdapter;
    unregisterServerAdapter = registry.unregisterServerAdapter;
    setOverridePaused = registry.setOverridePaused;
    vi.clearAllMocks();
    mocks.externalRecords.clear();

    unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
    setOverridePaused("claude_local", false);
    mocks.listAdapterPlugins.mockImplementation(() => [...mocks.externalRecords.values()]);
    mocks.getAdapterPluginsDir.mockReturnValue("/tmp/paperclip-adapter-route-authz-test");
    mocks.getDisabledAdapterTypes.mockReturnValue([]);
    mocks.setAdapterDisabled.mockReturnValue(true);
    mocks.buildExternalAdapters.mockResolvedValue([]);
    mocks.loadExternalAdapterPackage.mockResolvedValue(createAdapter());
    mocks.reloadExternalAdapter.mockImplementation(async (type: string) => createAdapter(type));
  }, 20_000);

  afterEach(() => {
    unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
    setOverridePaused("claude_local", false);
  });

  it("rejects mutating adapter routes for a non-instance-admin board user with company membership", async () => {
    for (const routeName of [
      "install",
      "disable",
      "override",
      "delete",
      "reload",
      "reinstall",
    ]) {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();
      const app = createApp(boardMember("admin"));

      const res = await sendMutatingRequest(app, routeName);

      expect(res.status, `${routeName}: ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it("allows instance admins to reach mutating adapter routes", async () => {
    for (const [routeName, expectedStatus] of [
      ["install", 201],
      ["disable", 200],
      ["override", 200],
      ["delete", 200],
      ["reload", 200],
      ["reinstall", 200],
    ] as const) {
      resetInstalledExternalAdapterState();
      if (routeName !== "install") {
        seedInstalledExternalAdapter();
      }
      const app = createApp(instanceAdmin);

      const res = await sendMutatingRequest(app, routeName);

      expect(res.status, `${routeName}: ${JSON.stringify(res.body)}`).toBe(expectedStatus);
    }
  });

  it.each(["viewer", "operator"] as const)(
    "does not let a company %s trigger adapter npm install or reload",
    async (membershipRole) => {
      seedInstalledExternalAdapter();
      const installApp = createApp(boardMember(membershipRole));
      const reloadApp = createApp(boardMember(membershipRole));

      const install = await requestApp(installApp, (baseUrl) =>
        request(baseUrl)
          .post("/api/adapters/install")
          .send({ packageName: EXTERNAL_PACKAGE_NAME }),
      );
      const reload = await requestApp(reloadApp, (baseUrl) =>
        request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`),
      );

      expect(install.status, JSON.stringify(install.body)).toBe(403);
      expect(reload.status, JSON.stringify(reload.body)).toBe(403);
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.loadExternalAdapterPackage).not.toHaveBeenCalled();
      expect(mocks.reloadExternalAdapter).not.toHaveBeenCalled();
    },
  );
});
