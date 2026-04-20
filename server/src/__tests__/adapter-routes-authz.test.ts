import express from "express";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    req.actor = actor;
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
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
      return request(app)
        .post("/api/adapters/install")
        .send({ packageName: EXTERNAL_PACKAGE_NAME });
    case "disable":
      return request(app)
        .patch(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`)
        .send({ disabled: true });
    case "override":
      return request(app)
        .patch("/api/adapters/claude_local/override")
        .send({ paused: true });
    case "delete":
      return request(app).delete(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`);
    case "reload":
      return request(app).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`);
    case "reinstall":
      return request(app).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reinstall`);
    default:
      throw new Error(`Unknown mutating adapter route: ${name}`);
  }
}

function seedInstalledExternalAdapter() {
  mocks.externalRecords.set(EXTERNAL_ADAPTER_TYPE, installedRecord());
  unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
  registerServerAdapter(createAdapter());
}

describe("adapter management route authorization", () => {
  beforeAll(async () => {
    const [routes, middleware, registry] = await Promise.all([
      import("../routes/adapters.js"),
      import("../middleware/index.js"),
      import("../adapters/registry.js"),
    ]);
    adapterRoutes = routes.adapterRoutes;
    errorHandler = middleware.errorHandler;
    registerServerAdapter = registry.registerServerAdapter;
    unregisterServerAdapter = registry.unregisterServerAdapter;
    setOverridePaused = registry.setOverridePaused;
  }, 20_000);

  beforeEach(() => {
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
  });

  afterEach(() => {
    unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
    setOverridePaused("claude_local", false);
  });

  it.each([
    "install",
    "disable",
    "override",
    "delete",
    "reload",
    "reinstall",
  ])("rejects %s for a non-instance-admin board user with company membership", async (routeName) => {
    seedInstalledExternalAdapter();
    const app = createApp(boardMember("admin"));

    const res = await sendMutatingRequest(app, routeName);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it.each([
    ["install", 201],
    ["disable", 200],
    ["override", 200],
    ["delete", 200],
    ["reload", 200],
    ["reinstall", 200],
  ] as const)("allows instance admins to reach %s", async (routeName, expectedStatus) => {
    if (routeName !== "install") {
      seedInstalledExternalAdapter();
    }
    const app = createApp(instanceAdmin);

    const res = await sendMutatingRequest(app, routeName);

    expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
  });

  it.each(["viewer", "operator"] as const)(
    "does not let a company %s trigger adapter npm install or reload",
    async (membershipRole) => {
      seedInstalledExternalAdapter();
      const app = createApp(boardMember(membershipRole));

      const install = await request(app)
        .post("/api/adapters/install")
        .send({ packageName: EXTERNAL_PACKAGE_NAME });
      const reload = await request(app).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`);

      expect(install.status, JSON.stringify(install.body)).toBe(403);
      expect(reload.status, JSON.stringify(reload.body)).toBe(403);
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.loadExternalAdapterPackage).not.toHaveBeenCalled();
      expect(mocks.reloadExternalAdapter).not.toHaveBeenCalled();
    },
  );
});
