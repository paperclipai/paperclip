import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const fsMkdtemp = promisify(fs.mkdtemp);

const mocks = vi.hoisted(() => {
  const externalRecords = new Map<string, any>();

  return {
    externalRecords,
    // Validator behavior (defaults to accept-all so the pre-existing
    // instance-admin + viewer/operator tests stay green). The new
    // agent-reachable tests override per-test.
    validateExternalPluginLoad: (_pkgDir: string) => ({
      ok: true,
      manifest: { name: "mocked", version: "0.0.0-test", keywords: ["paperclip-adapter-plugin"] },
    }),
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

// The validator reads package.json from the plugins dir. The existing
// tests mock `getAdapterPluginsDir` to return
// `/tmp/paperclip-adapter-route-authz-test`; we don't need a real
// package.json there because the validator will see what's actually
// on disk. To keep these tests passing without setting up a real
// package on disk per-test, override the validator via vi.doMock at
// the start of the suite. The agent-reachable tests in this file
// then override the doMock per-test to exercise the constraint stack.

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

// Agent fixture for the new agent-reachable install + reload paths
// (PHA-1657). Restricted to a single company; the validators in
// `routes/adapters.ts` reject cross-tenant agent keys.
const agent: Express.Request["actor"] = {
  type: "agent",
  agentId: "agent-1",
  keyId: "key-1",
  runId: null,
  companyId: "company-1",
  onBehalfOfUserId: null,
  onBehalfOfMemberships: [
    { companyId: "company-1", membershipRole: "admin", status: "active" },
  ],
  source: "agent_key",
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

// Real plugins dir on disk so the validator can find a real
// package.json with the keyword. Used by the pre-existing
// instance-admin tests (which install into this dir) and the new
// agent-reachable tests (which install into a per-test temp dir).
const REAL_PLUGINS_DIR = path.join(os.tmpdir(), `paperclip-authz-plugins-${process.pid}-${Math.random().toString(36).slice(2)}`);
function seedRealPluginsDir() {
  fs.mkdirSync(REAL_PLUGINS_DIR, { recursive: true });
  const nodeModules = path.join(REAL_PLUGINS_DIR, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  const pkgDir = path.join(nodeModules, EXTERNAL_PACKAGE_NAME);
  fs.mkdirSync(pkgDir, { recursive: true });
  const pkgJsonPath = path.join(pkgDir, "package.json");
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify({ name: EXTERNAL_PACKAGE_NAME, version: "1.0.0-test", keywords: ["paperclip-adapter-plugin"] }),
  );
  // Backdate so the mtime floor is satisfied.
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(pkgJsonPath, old, old);
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
    vi.doUnmock("../services/adapter-plugin-validator.js");
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
    // Real plugins dir on disk so the validator can find a real
    // package.json with the keyword. Created lazily so test ordering
    // doesn't matter.
    seedRealPluginsDir();
    mocks.getAdapterPluginsDir.mockReturnValue(REAL_PLUGINS_DIR);
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

  describe("cloud-managed adapter code install floor", () => {
    beforeEach(() => {
      process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "test-server-token";
    });
    afterEach(() => {
      delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    });

    it.each(["install", "reinstall"] as const)(
      "floors adapter %s off for instance admins on cloud-managed instances",
      async (routeName) => {
        resetInstalledExternalAdapterState();
        if (routeName !== "install") {
          seedInstalledExternalAdapter();
        }
        const app = createApp(instanceAdmin);

        const res = await sendMutatingRequest(app, routeName);

        expect(res.status, `${routeName}: ${JSON.stringify(res.body)}`).toBe(403);
        expect(res.body.details).toMatchObject({ code: "adapter_install_platform_managed" });
        expect(mocks.execFile).not.toHaveBeenCalled();
        expect(mocks.loadExternalAdapterPackage).not.toHaveBeenCalled();
      },
    );
  });

  describe("agent-reachable install and reload (PHA-1657)", () => {
    it("allows an agent to install when the validator passes", async () => {
      resetInstalledExternalAdapterState();
      // By default the validator mocks resolve to a directory inside
      // /tmp that does not exist as a real package. We pre-arrange by
      // stubbing the package loader and writing a real package.json
      // with the required keyword into a temp plugins dir.
      const tmpPluginsDir = await fsMkdtemp(path.join(os.tmpdir(), "pc-agent-install-"));
      const pkgDir = path.join(tmpPluginsDir, "paperclip-agent-test-pkg");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "paperclip-agent-test-pkg", version: "1.0.0", keywords: ["paperclip-adapter-plugin"] }),
      );
      const old = Date.now() / 1000 - 60;
      fs.utimesSync(path.join(pkgDir, "package.json"), old, old);
      mocks.getAdapterPluginsDir.mockReturnValue(tmpPluginsDir);
      mocks.externalRecords.clear();
      unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
      registerServerAdapter(createAdapter());

      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/adapters/install")
          .send({ packageName: pkgDir, isLocalPath: true }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.type).toBe(EXTERNAL_ADAPTER_TYPE);

      fs.rmSync(tmpPluginsDir, { recursive: true, force: true });
    });

    it("rejects an agent install when the validator rejects (missing keyword)", async () => {
      resetInstalledExternalAdapterState();
      const tmpPluginsDir = await fsMkdtemp(path.join(os.tmpdir(), "pc-agent-install-reject-"));
      const pkgDir = path.join(tmpPluginsDir, "no-keyword-pkg");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "no-keyword-pkg", version: "1.0.0", keywords: [] }),
      );
      const old = Date.now() / 1000 - 60;
      fs.utimesSync(path.join(pkgDir, "package.json"), old, old);
      mocks.getAdapterPluginsDir.mockReturnValue(tmpPluginsDir);
      mocks.externalRecords.clear();
      unregisterServerAdapter(EXTERNAL_ADAPTER_TYPE);
      registerServerAdapter(createAdapter());

      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/adapters/install")
          .send({ packageName: pkgDir, isLocalPath: true }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/missing_keyword/);

      fs.rmSync(tmpPluginsDir, { recursive: true, force: true });
    });

    it("allows an agent to reload an already-installed plugin when the validator passes", async () => {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();

      const tmpPluginsDir = await fsMkdtemp(path.join(os.tmpdir(), "pc-agent-reload-"));
      const pkgDir = path.join(tmpPluginsDir, "reload-pkg");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "reload-pkg", version: "2.0.0", keywords: ["paperclip-adapter-plugin"] }),
      );
      const old = Date.now() / 1000 - 60;
      fs.utimesSync(path.join(pkgDir, "package.json"), old, old);
      mocks.getAdapterPluginsDir.mockReturnValue(tmpPluginsDir);
      // Install a record pointing at the temp dir so the validator has
      // a `localPath` to walk.
      mocks.externalRecords.set(EXTERNAL_ADAPTER_TYPE, {
        ...installedRecord(),
        localPath: pkgDir,
      });

      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ type: EXTERNAL_ADAPTER_TYPE, reloaded: true });

      fs.rmSync(tmpPluginsDir, { recursive: true, force: true });
    });

    it("rejects an agent reload when the validator rejects (missing keyword)", async () => {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();

      const tmpPluginsDir = await fsMkdtemp(path.join(os.tmpdir(), "pc-agent-reload-reject-"));
      const pkgDir = path.join(tmpPluginsDir, "bad-reload-pkg");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "bad-reload-pkg", version: "2.0.0", keywords: ["something-else"] }),
      );
      const old = Date.now() / 1000 - 60;
      fs.utimesSync(path.join(pkgDir, "package.json"), old, old);
      mocks.getAdapterPluginsDir.mockReturnValue(tmpPluginsDir);
      mocks.externalRecords.set(EXTERNAL_ADAPTER_TYPE, {
        ...installedRecord(),
        localPath: pkgDir,
      });

      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reload`),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/missing_keyword/);
      // Reload path should NOT have been called — validator short-circuited.
      expect(mocks.reloadExternalAdapter).not.toHaveBeenCalled();

      fs.rmSync(tmpPluginsDir, { recursive: true, force: true });
    });

    it("rejects an agent on reinstall (stays Board-only, npm pull)", async () => {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();
      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}/reinstall`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });

    it("rejects an agent on delete (stays Board-only)", async () => {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();
      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });

    it("rejects an agent on disable (stays Board-only)", async () => {
      resetInstalledExternalAdapterState();
      seedInstalledExternalAdapter();
      const app = createApp(agent);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/adapters/${EXTERNAL_ADAPTER_TYPE}`).send({ disabled: true }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
  });
});
