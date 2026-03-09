import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = {
  list: vi.fn(),
  listInstalled: vi.fn(),
  listByStatus: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
  listCompanyAvailability: vi.fn(),
  getCompanyAvailability: vi.fn(),
  updateCompanyAvailability: vi.fn(),
  seedEnabledForAllCompanies: vi.fn(),
};

const lifecycle = {
  load: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  upgrade: vi.fn(),
};

const loader = {
  installPlugin: vi.fn(),
};

// Mock DB query builder chain for webhook deliveries
const mockDbReturning = vi.fn();
const mockDbValues = vi.fn();
const mockDbInsert = vi.fn();
const mockDbWhere = vi.fn();
const mockDbSet = vi.fn();
const mockDbUpdate = vi.fn();
const mockDb = {
  insert: mockDbInsert,
  update: mockDbUpdate,
};

/** Re-wire the mock DB chain after clearAllMocks. */
function resetDbMocks() {
  mockDbReturning.mockResolvedValue([{ id: "delivery-uuid-1" }]);
  mockDbValues.mockReturnValue({ returning: mockDbReturning });
  mockDbInsert.mockReturnValue({ values: mockDbValues });
  mockDbWhere.mockResolvedValue(undefined);
  mockDbSet.mockReturnValue({ where: mockDbWhere });
  mockDbUpdate.mockReturnValue({ set: mockDbSet });
}

// Mock worker manager for webhook RPC calls
const mockWorkerManager = {
  call: vi.fn(),
  getWorker: vi.fn(),
  isRunning: vi.fn(),
  startWorker: vi.fn(),
  stopWorker: vi.fn(),
  stopAll: vi.fn(),
  diagnostics: vi.fn(),
};

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => registry),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: vi.fn(() => lifecycle),
}));

vi.mock("../services/plugin-loader.js", () => ({
  pluginLoader: vi.fn(() => loader),
  getPluginUiContributionMetadata: vi.fn((manifest: any) => {
    const slots = manifest?.ui?.slots ?? [];
    const launchers = [
      ...(manifest?.launchers ?? []),
      ...(manifest?.ui?.launchers ?? []),
    ];

    if (slots.length === 0 && launchers.length === 0) {
      return null;
    }

    return {
      uiEntryFile: "index.js",
      slots,
      launchers,
    };
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

import { pluginRoutes } from "../routes/plugins.js";
import type { PluginRouteWebhookDeps, PluginRouteBridgeDeps, PluginRouteToolDeps } from "../routes/plugins.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { logActivity } from "../services/activity-log.js";

function createApp(
  actorType: "board" | "agent",
  options?: { companyIds?: string[]; isInstanceAdmin?: boolean },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? {
          type: "board",
          source: "session",
          userId: "u_board",
          isInstanceAdmin: options?.isInstanceAdmin ?? true,
          companyIds: options?.companyIds ?? [],
        }
      : {
          type: "agent",
          companyId: "c1",
          agentId: "a1",
        };
    next();
  });
  app.use(pluginRoutes({} as never, loader as any));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.status(status).json({ error: message });
  });
  return app;
}

function createWebhookApp() {
  const webhookDeps: PluginRouteWebhookDeps = {
    workerManager: mockWorkerManager as any,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "u_board",
      isInstanceAdmin: true,
      companyIds: [],
    };
    next();
  });
  app.use(pluginRoutes(mockDb as any, loader as any, undefined, webhookDeps));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.status(status).json({ error: message });
  });
  return app;
}

function createMockPlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    pluginKey: "acme.test",
    version: "1.0.0",
    status: "ready",
    packageName: "@acme/test",
    installedAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    manifestJson: {
      id: "acme.test",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Test Plugin",
      description: "A test plugin",
      author: "Test Author",
      categories: ["connector"],
      capabilities: [],
      entrypoints: { worker: "./worker.js" },
    },
    ...overrides,
  };
}

describe("plugin routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Reset mock implementations to default behavior
    registry.list.mockResolvedValue([]);
    registry.listByStatus.mockResolvedValue([]);
    registry.getById.mockResolvedValue(null);
    registry.getByKey.mockResolvedValue(null);
    registry.listCompanyAvailability.mockResolvedValue([]);
    registry.getCompanyAvailability.mockResolvedValue({
      companyId: "c1",
      pluginId: "p1",
      pluginKey: "acme.test",
      pluginDisplayName: "Test Plugin",
      pluginStatus: "ready",
      available: true,
      settingsJson: {},
      lastError: null,
      createdAt: null,
      updatedAt: null,
    });
    registry.updateCompanyAvailability.mockResolvedValue(null);
    registry.seedEnabledForAllCompanies.mockResolvedValue(0);
    lifecycle.load.mockResolvedValue(undefined);
    lifecycle.unload.mockResolvedValue(undefined);
    lifecycle.enable.mockResolvedValue(undefined);
    lifecycle.disable.mockResolvedValue(undefined);
    lifecycle.upgrade.mockResolvedValue(undefined);
    loader.installPlugin.mockResolvedValue({ manifest: { id: "test" } });
    // Reset webhook-related mocks
    resetDbMocks();
    mockWorkerManager.call.mockResolvedValue(undefined);
  });

  describe("company-scoped plugin availability routes", () => {
    it("lists company plugin availability without a filter and preserves enabled-by-default records", async () => {
      registry.listCompanyAvailability.mockResolvedValueOnce([
        {
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.test",
          pluginDisplayName: "Test Plugin",
          pluginStatus: "ready",
          available: true,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        },
        {
          companyId: "c1",
          pluginId: "p2",
          pluginKey: "acme.disabled",
          pluginDisplayName: "Disabled Plugin",
          pluginStatus: "ready",
          available: false,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        },
      ]);

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app).get("/companies/c1/plugins");

      expect(res.status).toBe(200);
      expect(registry.listCompanyAvailability).toHaveBeenCalledWith("c1", { available: undefined });
      expect(res.body).toMatchObject([
        {
          companyId: "c1",
          pluginId: "p1",
          available: true,
        },
        {
          companyId: "c1",
          pluginId: "p2",
          available: false,
        },
      ]);
    });

    it("lists company plugin availability for a board actor with access", async () => {
      registry.listCompanyAvailability.mockResolvedValueOnce([
        {
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.test",
          pluginDisplayName: "Test Plugin",
          pluginStatus: "ready",
          available: true,
          settingsJson: { teamId: "t1" },
          lastError: null,
          createdAt: null,
          updatedAt: null,
        },
      ]);

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app).get("/companies/c1/plugins?available=true");

      expect(res.status).toBe(200);
      expect(registry.listCompanyAvailability).toHaveBeenCalledWith("c1", { available: true });
      expect(res.body[0]).toMatchObject({
        companyId: "c1",
        pluginId: "p1",
        available: true,
      });
    });

    it("gets one company plugin availability record by plugin key", async () => {
      registry.getByKey.mockResolvedValueOnce(createMockPlugin());
      registry.getCompanyAvailability.mockResolvedValueOnce({
        companyId: "c1",
        pluginId: "p1",
        pluginKey: "acme.test",
        pluginDisplayName: "Test Plugin",
        pluginStatus: "ready",
        available: false,
        settingsJson: {},
        lastError: null,
        createdAt: null,
        updatedAt: null,
      });

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app).get("/companies/c1/plugins/acme.test");

      expect(res.status).toBe(200);
      expect(registry.getCompanyAvailability).toHaveBeenCalledWith("c1", "p1");
      expect(res.body).toMatchObject({
        companyId: "c1",
        pluginKey: "acme.test",
        available: false,
      });
    });

    it("updates company plugin availability and writes an activity log", async () => {
      registry.getByKey.mockResolvedValueOnce(createMockPlugin());
      registry.updateCompanyAvailability.mockResolvedValueOnce({
        companyId: "c1",
        pluginId: "p1",
        pluginKey: "acme.test",
        pluginDisplayName: "Test Plugin",
        pluginStatus: "ready",
        available: true,
        settingsJson: { teamId: "t1" },
        lastError: null,
        createdAt: null,
        updatedAt: null,
      });

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app)
        .put("/companies/c1/plugins/acme.test")
        .send({ available: true, settingsJson: { teamId: "t1" } });

      expect(res.status).toBe(200);
      expect(registry.updateCompanyAvailability).toHaveBeenCalledWith("c1", "p1", {
        available: true,
        settingsJson: { teamId: "t1" },
      });
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId: "c1",
        action: "plugin.company_settings.updated",
        entityType: "plugin_company_settings",
        actorType: "user",
      }));
    });

    it("disables company plugin availability and writes an activity log", async () => {
      registry.getByKey.mockResolvedValueOnce(createMockPlugin());
      registry.updateCompanyAvailability.mockResolvedValueOnce({
        companyId: "c1",
        pluginId: "p1",
        pluginKey: "acme.test",
        pluginDisplayName: "Test Plugin",
        pluginStatus: "ready",
        available: false,
        settingsJson: {},
        lastError: null,
        createdAt: null,
        updatedAt: null,
      });

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app)
        .put("/companies/c1/plugins/acme.test")
        .send({ available: false });

      expect(res.status).toBe(200);
      expect(registry.updateCompanyAvailability).toHaveBeenCalledWith("c1", "p1", {
        available: false,
      });
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId: "c1",
        action: "plugin.company_settings.updated",
        entityType: "plugin_company_settings",
        actorType: "user",
        details: expect.objectContaining({
          pluginId: "p1",
          pluginKey: "acme.test",
          available: false,
        }),
      }));
    });

    it("rejects company-scoped plugin reads for boards without company access", async () => {
      const app = createApp("board", { companyIds: ["c1"], isInstanceAdmin: false });
      const res = await request(app).get("/companies/c2/plugins");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "User does not have access to this company" });
      expect(registry.listCompanyAvailability).not.toHaveBeenCalled();
    });

    it("rejects company-scoped plugin updates for boards without company access", async () => {
      const app = createApp("board", { companyIds: ["c1"], isInstanceAdmin: false });
      const res = await request(app)
        .put("/companies/c2/plugins/acme.test")
        .send({ available: true });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "User does not have access to this company" });
      expect(registry.getByKey).not.toHaveBeenCalled();
      expect(registry.updateCompanyAvailability).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /plugins - List plugins
  // ---------------------------------------------------------------------------
  describe("GET /plugins", () => {
    it("returns plugin list to board actor", async () => {
      registry.listInstalled.mockResolvedValueOnce([
        createMockPlugin({ id: "p1", pluginKey: "acme.core" }),
      ]);

      const app = createApp("board");
      const res = await request(app).get("/plugins");

      expect(res.status).toBe(200);
      expect(registry.listInstalled).toHaveBeenCalledTimes(1);
      expect(res.body).toMatchObject([{ id: "p1", pluginKey: "acme.core" }]);
    });

    it("filters plugins by status", async () => {
      registry.listByStatus.mockResolvedValueOnce([
        createMockPlugin({ id: "p1", status: "ready" }),
      ]);

      const app = createApp("board");
      const res = await request(app).get("/plugins?status=ready");

      expect(res.status).toBe(200);
      expect(registry.listByStatus).toHaveBeenCalledWith("ready");
      expect(res.body).toMatchObject([{ id: "p1", status: "ready" }]);
    });

    it("rejects invalid status with 400", async () => {
      const app = createApp("board");
      const res = await request(app).get("/plugins?status=invalid");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid status/i);
      expect(registry.listByStatus).not.toHaveBeenCalled();
    });

    it("rejects numeric status value with 400", async () => {
      // Validates that non-string coercible values are rejected.
      // Note: Express 5 treats ?status[]=x as status[] key (undefined), not status.
      // Using ?status=42 to verify numeric strings are rejected.
      const app = createApp("board");
      const res = await request(app).get("/plugins?status=42");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid status/i);
      expect(registry.listByStatus).not.toHaveBeenCalled();
    });

    it("returns plugin list when no status filter provided (excludes uninstalled)", async () => {
      registry.listInstalled.mockResolvedValueOnce([createMockPlugin()]);

      const app = createApp("board");
      const res = await request(app).get("/plugins");

      expect(res.status).toBe(200);
      expect(registry.listInstalled).toHaveBeenCalledTimes(1);
      expect(registry.listByStatus).not.toHaveBeenCalled();
    });

    it("rejects agent access", async () => {
      const app = createApp("agent");
      const res = await request(app).get("/plugins");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Board access required" });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /plugins/ui-contributions - UI contributions
  // ---------------------------------------------------------------------------
  describe("GET /plugins/ui-contributions", () => {
    it("returns ready plugin UI contributions with slots and launchers and omits empty manifests", async () => {
      registry.listByStatus.mockResolvedValueOnce([
        createMockPlugin({
          id: "p1",
          pluginKey: "acme.with-ui",
          version: "1.0.0",
          manifestJson: {
            id: "acme.with-ui",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "With UI",
            description: "Test plugin with UI",
            author: "Test Author",
            categories: ["ui"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            ui: {
              slots: [
                {
                  id: "slot-1",
                  type: "toolbarButton",
                  displayName: "Do Thing",
                  exportName: "DoThingButton",
                },
              ],
              launchers: [
                {
                  id: "launcher-1",
                  displayName: "Open Panel",
                  placementZone: "toolbarButton",
                  action: {
                    type: "navigate",
                    target: "/plugins/acme.with-ui",
                  },
                },
              ],
            },
          },
        }),
        createMockPlugin({
          id: "p2",
          pluginKey: "acme.launcher-only",
          version: "1.0.1",
          manifestJson: {
            id: "acme.launcher-only",
            apiVersion: 1,
            version: "1.0.1",
            displayName: "Launcher Only",
            description: "Test plugin with launcher metadata only",
            author: "Test Author",
            categories: ["connector"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            launchers: [
              {
                id: "launcher-2",
                displayName: "Sync Now",
                placementZone: "projectSidebarItem",
                entityTypes: ["project"],
                action: {
                  type: "performAction",
                  target: "sync-now",
                },
              },
            ],
          },
        }),
        createMockPlugin({
          id: "p3",
          pluginKey: "acme.no-ui",
          version: "1.0.2",
          manifestJson: {
            id: "acme.no-ui",
            apiVersion: 1,
            version: "1.0.2",
            displayName: "No UI",
            description: "Test plugin without UI",
            author: "Test Author",
            categories: ["connector"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            ui: {
              slots: [],
              launchers: [],
            },
          },
        }),
      ]);

      const app = createApp("board");
      const res = await request(app).get("/plugins/ui-contributions");

      expect(res.status).toBe(200);
      expect(registry.listByStatus).toHaveBeenCalledWith("ready");
      expect(res.body).toEqual([
        {
          pluginId: "p1",
          pluginKey: "acme.with-ui",
          displayName: "With UI",
          version: "1.0.0",
          updatedAt: "2024-01-01T00:00:00.000Z",
          uiEntryFile: "index.js",
          slots: [
            {
              id: "slot-1",
              type: "toolbarButton",
              displayName: "Do Thing",
              exportName: "DoThingButton",
            },
          ],
          launchers: [
            {
              id: "launcher-1",
              displayName: "Open Panel",
              placementZone: "toolbarButton",
              action: {
                type: "navigate",
                target: "/plugins/acme.with-ui",
              },
            },
          ],
        },
        {
          pluginId: "p2",
          pluginKey: "acme.launcher-only",
          displayName: "Launcher Only",
          version: "1.0.1",
          updatedAt: "2024-01-01T00:00:00.000Z",
          uiEntryFile: "index.js",
          slots: [],
          launchers: [
            {
              id: "launcher-2",
              displayName: "Sync Now",
              placementZone: "projectSidebarItem",
              entityTypes: ["project"],
              action: {
                type: "performAction",
                target: "sync-now",
              },
            },
          ],
        },
      ]);
    });

    it("handles plugins with null manifestJson gracefully", async () => {
      registry.listByStatus.mockResolvedValueOnce([
        createMockPlugin({
          id: "p1",
          manifestJson: null,
        }),
      ]);

      const app = createApp("board");
      const res = await request(app).get("/plugins/ui-contributions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns both legacy top-level and ui-scoped launcher declarations", async () => {
      registry.listByStatus.mockResolvedValueOnce([
        createMockPlugin({
          id: "p1",
          pluginKey: "acme.mixed-launchers",
          manifestJson: {
            id: "acme.mixed-launchers",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Mixed Launchers",
            description: "Includes both launcher declaration styles",
            author: "Test Author",
            categories: ["ui"],
            capabilities: [],
            entrypoints: { worker: "./worker.js", ui: "./ui" },
            launchers: [
              {
                id: "legacy-launcher",
                displayName: "Legacy Launcher",
                placementZone: "toolbarButton",
                action: { type: "navigate", target: "/legacy" },
              },
            ],
            ui: {
              launchers: [
                {
                  id: "ui-launcher",
                  displayName: "UI Launcher",
                  placementZone: "toolbarButton",
                  action: { type: "navigate", target: "/ui" },
                },
              ],
            },
          },
        }),
      ]);

      const app = createApp("board");
      const res = await request(app).get("/plugins/ui-contributions");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({
          pluginId: "p1",
          slots: [],
          launchers: [
            {
              id: "legacy-launcher",
              displayName: "Legacy Launcher",
              placementZone: "toolbarButton",
              action: { type: "navigate", target: "/legacy" },
            },
            {
              id: "ui-launcher",
              displayName: "UI Launcher",
              placementZone: "toolbarButton",
              action: { type: "navigate", target: "/ui" },
            },
          ],
        }),
      ]);
    });

    it("filters UI contributions by company-scoped plugin availability", async () => {
      registry.listByStatus.mockResolvedValueOnce([
        createMockPlugin({
          id: "p1",
          pluginKey: "acme.enabled",
          manifestJson: {
            id: "acme.enabled",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Enabled Plugin",
            description: "Available to company",
            author: "Test Author",
            categories: ["ui"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            ui: {
              slots: [{ id: "slot-1", type: "toolbarButton", displayName: "Enabled", exportName: "EnabledButton" }],
              launchers: [],
            },
          },
        }),
        createMockPlugin({
          id: "p2",
          pluginKey: "acme.disabled",
          manifestJson: {
            id: "acme.disabled",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Disabled Plugin",
            description: "Not available to company",
            author: "Test Author",
            categories: ["ui"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            ui: {
              slots: [{ id: "slot-2", type: "toolbarButton", displayName: "Disabled", exportName: "DisabledButton" }],
              launchers: [],
            },
          },
        }),
      ]);
      registry.listCompanyAvailability.mockResolvedValueOnce([
        {
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.enabled",
          pluginDisplayName: "Enabled Plugin",
          pluginStatus: "ready",
          available: true,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        },
      ]);

      const app = createApp("board", { companyIds: ["c1"] });
      const res = await request(app).get("/plugins/ui-contributions?companyId=c1");

      expect(res.status).toBe(200);
      expect(registry.listCompanyAvailability).toHaveBeenCalledWith("c1", { available: true });
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ pluginId: "p1", pluginKey: "acme.enabled" });
    });

    it("rejects agent access with board-required error", async () => {
      const app = createApp("agent");
      const res = await request(app).get("/plugins/ui-contributions");

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Board access required" });
      expect(registry.listByStatus).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /plugins/:pluginId - Get single plugin
  // ---------------------------------------------------------------------------
  describe("GET /plugins/:pluginId", () => {
    it("returns plugin by ID", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1" }));

      const app = createApp("board");
      const res = await request(app).get("/plugins/p1");

      expect(res.status).toBe(200);
      expect(registry.getById).toHaveBeenCalledWith("p1");
    });

    it("returns plugin by key if ID not found", async () => {
      // Slug "acme.test" is not a UUID, so resolvePlugin tries getByKey first
      registry.getByKey.mockResolvedValueOnce(createMockPlugin({ pluginKey: "acme.test" }));

      const app = createApp("board");
      const res = await request(app).get("/plugins/acme.test");

      expect(res.status).toBe(200);
      expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app).get("/plugins/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/install - Install plugin
  // ---------------------------------------------------------------------------
  describe("POST /plugins/install", () => {
    it("installs npm package successfully", async () => {
      loader.installPlugin.mockResolvedValueOnce({
        manifest: { id: "acme.new" },
      });
      registry.getByKey.mockResolvedValueOnce(createMockPlugin({ pluginKey: "acme.new" }));
      lifecycle.load.mockResolvedValueOnce(undefined);
      registry.getById.mockResolvedValueOnce(createMockPlugin({ pluginKey: "acme.new" }));

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "@acme/new-plugin", version: "1.0.0" });

      expect(res.status).toBe(200);
      expect(loader.installPlugin).toHaveBeenCalledWith({
        packageName: "@acme/new-plugin",
        version: "1.0.0",
      });
      expect(registry.seedEnabledForAllCompanies).toHaveBeenCalledWith("p1");
    });

    it("installs local path successfully", async () => {
      loader.installPlugin.mockResolvedValueOnce({
        manifest: { id: "acme.local" },
      });
      registry.getByKey.mockResolvedValueOnce(createMockPlugin({ pluginKey: "acme.local" }));
      lifecycle.load.mockResolvedValueOnce(undefined);
      registry.getById.mockResolvedValueOnce(createMockPlugin({ pluginKey: "acme.local" }));

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "./my-plugin", isLocalPath: true });

      expect(res.status).toBe(200);
      expect(loader.installPlugin).toHaveBeenCalledWith({
        localPath: "./my-plugin",
      });
      expect(registry.seedEnabledForAllCompanies).toHaveBeenCalledWith("p1");
    });

    it("rejects missing packageName", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "packageName is required and must be a string" });
    });

    it("rejects empty packageName", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "   " });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "packageName cannot be empty" });
    });

    it("rejects invalid packageName type", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: 123 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "packageName is required and must be a string" });
    });

    it("rejects invalid version type", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "test", version: 123 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "version must be a string if provided" });
    });

    it("rejects invalid isLocalPath type", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "test", isLocalPath: "yes" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "isLocalPath must be a boolean if provided" });
    });

    it("rejects packageName with invalid characters", async () => {
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "test<script>" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "packageName contains invalid characters" });
    });

    it("handles install errors", async () => {
      loader.installPlugin.mockRejectedValueOnce(new Error("Package not found"));

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "@acme/nonexistent" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Package not found" });
    });

    it("returns 500 when installPlugin returns a discovered plugin with null manifest", async () => {
      loader.installPlugin.mockResolvedValueOnce({ manifest: null });

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/install")
        .send({ packageName: "@acme/broken-plugin" });

      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/manifest is missing/i);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /plugins/:pluginId - Uninstall plugin
  // ---------------------------------------------------------------------------
  describe("DELETE /plugins/:pluginId", () => {
    it("uninstalls plugin with soft delete", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1" }));
      lifecycle.unload.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "uninstalled" }));

      const app = createApp("board");
      const res = await request(app).delete("/plugins/p1");

      expect(res.status).toBe(200);
      expect(lifecycle.unload).toHaveBeenCalledWith("p1", false);
    });

    it("uninstalls plugin with purge", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1" }));
      lifecycle.unload.mockResolvedValueOnce(createMockPlugin({ id: "p1" }));

      const app = createApp("board");
      const res = await request(app).delete("/plugins/p1?purge=true");

      expect(res.status).toBe(200);
      expect(lifecycle.unload).toHaveBeenCalledWith("p1", true);
    });

    it("resolves scoped plugin key without UUID lookup", async () => {
      const scopedKey = "@paperclipai/plugin-hello-world-example";
      registry.getByKey.mockResolvedValueOnce(createMockPlugin({ id: "p-scoped", pluginKey: scopedKey }));
      lifecycle.unload.mockResolvedValueOnce(createMockPlugin({ id: "p-scoped", status: "uninstalled", pluginKey: scopedKey }));

      const app = createApp("board");
      const res = await request(app).delete(`/plugins/${encodeURIComponent(scopedKey)}?purge=true`);

      expect(res.status).toBe(200);
      expect(registry.getByKey).toHaveBeenCalledWith(scopedKey);
      expect(registry.getById).not.toHaveBeenCalledWith(scopedKey);
      expect(lifecycle.unload).toHaveBeenCalledWith("p-scoped", true);
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app).delete("/plugins/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:pluginId/enable - Enable plugin
  // ---------------------------------------------------------------------------
  describe("POST /plugins/:pluginId/enable", () => {
    it("enables a plugin", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "installed" }));
      lifecycle.enable.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "ready" }));

      const app = createApp("board");
      const res = await request(app).post("/plugins/p1/enable");

      expect(res.status).toBe(200);
      expect(lifecycle.enable).toHaveBeenCalledWith("p1");
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app).post("/plugins/nonexistent/enable");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:pluginId/disable - Disable plugin
  // ---------------------------------------------------------------------------
  describe("POST /plugins/:pluginId/disable", () => {
    it("disables a plugin", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "ready" }));
      lifecycle.disable.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "installed" }));

      const app = createApp("board");
      const res = await request(app).post("/plugins/p1/disable");

      expect(res.status).toBe(200);
      expect(lifecycle.disable).toHaveBeenCalledWith("p1", undefined);
    });

    it("disables a plugin with reason", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "ready" }));
      lifecycle.disable.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "installed" }));

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/p1/disable")
        .send({ reason: "Maintenance" });

      expect(res.status).toBe(200);
      expect(lifecycle.disable).toHaveBeenCalledWith("p1", "Maintenance");
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app).post("/plugins/nonexistent/disable");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /plugins/:pluginId/health - Health check
  // ---------------------------------------------------------------------------
  describe("GET /plugins/:pluginId/health", () => {
    it("returns healthy status for ready plugin", async () => {
      registry.getById.mockResolvedValueOnce(createMockPlugin({ id: "p1", status: "ready" }));

      const app = createApp("board");
      const res = await request(app).get("/plugins/p1/health");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        pluginId: "p1",
        status: "ready",
        healthy: true,
      });
      expect(res.body.checks).toContainEqual(
        expect.objectContaining({ name: "status", passed: true })
      );
    });

    it("returns unhealthy status for error plugin", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({ id: "p1", status: "error", lastError: "Something went wrong" })
      );

      const app = createApp("board");
      const res = await request(app).get("/plugins/p1/health");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        pluginId: "p1",
        status: "error",
        healthy: false,
        lastError: "Something went wrong",
      });
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app).get("/plugins/nonexistent/health");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:pluginId/upgrade - Upgrade plugin
  // ---------------------------------------------------------------------------
  describe("POST /plugins/:pluginId/upgrade", () => {
    it("upgrades a plugin", async () => {
      registry.getById.mockResolvedValue(createMockPlugin({ id: "p1", status: "ready" }));
      registry.getByKey.mockResolvedValue(null);
      lifecycle.upgrade.mockResolvedValue(createMockPlugin({ id: "p1", version: "1.1.0" }));

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/p1/upgrade")
        .send({ version: "1.1.0" });

      expect(res.status).toBe(200);
      expect(lifecycle.upgrade).toHaveBeenCalledWith("p1", "1.1.0");
    });

    it("upgrades to latest without specifying version", async () => {
      registry.getById.mockResolvedValue(createMockPlugin({ id: "p1", status: "ready" }));
      registry.getByKey.mockResolvedValue(null);
      lifecycle.upgrade.mockResolvedValue(createMockPlugin({ id: "p1" }));      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/p1/upgrade")
        .send({});

      expect(res.status).toBe(200);
      expect(lifecycle.upgrade).toHaveBeenCalledWith("p1", undefined);
    });

    it("returns 404 if plugin not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/nonexistent/upgrade")
        .send({});

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: "Plugin not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // Route ordering tests
  // ---------------------------------------------------------------------------
  describe("route ordering", () => {
    it("ui-contributions is not matched as :pluginId", async () => {
      // This test ensures that /plugins/ui-contributions is matched
      // before /plugins/:pluginId
      registry.listByStatus.mockResolvedValueOnce([]);

      const app = createApp("board");
      const res = await request(app).get("/plugins/ui-contributions");

      // Should call listByStatus (for ui-contributions), not getById
      expect(res.status).toBe(200);
      expect(registry.listByStatus).toHaveBeenCalledWith("ready");
      expect(registry.getById).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // POST /plugins/:pluginId/webhooks/:endpointKey - Webhook ingestion
  // ---------------------------------------------------------------------------
  describe("POST /plugins/:pluginId/webhooks/:endpointKey", () => {
    const webhookPlugin = createMockPlugin({
      id: "p1",
      pluginKey: "acme.test",
      status: "ready",
      manifestJson: {
        id: "acme.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Test Plugin",
        description: "A test plugin with webhooks",
        author: "Test Author",
        categories: ["connector"],
        capabilities: ["webhooks.receive"],
        entrypoints: { worker: "./worker.js" },
        webhooks: [
          {
            endpointKey: "github-push",
            displayName: "GitHub Push",
            description: "Receives GitHub push events",
          },
        ],
      },
    });

    beforeEach(() => {
      resetDbMocks();
      mockWorkerManager.call.mockResolvedValue(undefined);
    });

    it("returns 501 when webhookDeps is not provided", async () => {
      // No need to set up registry mocks — the route returns 501
      // before resolving the plugin.
      const app = createApp("board");
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(501);
      expect(res.body).toEqual({ error: "Webhook ingestion is not enabled" });
    });

    it("returns 404 when plugin is not found", async () => {
      registry.getById.mockResolvedValueOnce(null);
      registry.getByKey.mockResolvedValueOnce(null);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/nonexistent/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Plugin not found" });
    });

    it("returns 400 when plugin is not in ready state", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({ ...webhookPlugin, status: "installed" }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not ready/i);
    });

    it("returns 400 when plugin lacks webhooks.receive capability", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({
          id: "p1",
          status: "ready",
          manifestJson: {
            id: "acme.test",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Test Plugin",
            description: "No webhook capability",
            author: "Test Author",
            categories: ["connector"],
            capabilities: ["events.subscribe"],
            entrypoints: { worker: "./worker.js" },
            webhooks: [{ endpointKey: "github-push", displayName: "GitHub Push" }],
          },
        }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/webhooks\.receive/);
    });

    it("returns 404 when endpointKey is not declared in the manifest", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/unknown-endpoint")
        .send({ event: "push" });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/unknown-endpoint.*not declared/i);
    });

    it("records delivery and dispatches to worker on success", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push", ref: "refs/heads/main" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        deliveryId: "delivery-uuid-1",
        status: "success",
      });

      // Verify DB insert was called with the right data
      expect(mockDbInsert).toHaveBeenCalled();
      expect(mockDbValues).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "p1",
          webhookKey: "github-push",
          status: "pending",
        }),
      );

      // Verify worker RPC was called
      expect(mockWorkerManager.call).toHaveBeenCalledWith(
        "p1",
        "handleWebhook",
        expect.objectContaining({
          endpointKey: "github-push",
          rawBody: expect.any(String),
          requestId: expect.any(String),
        }),
      );

      // Verify delivery was updated to success
      expect(mockDbUpdate).toHaveBeenCalled();
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          durationMs: expect.any(Number),
        }),
      );
    });

    it("records failed delivery when worker RPC fails", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);
      mockWorkerManager.call.mockRejectedValueOnce(
        new Error("Worker process is not running"),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        deliveryId: "delivery-uuid-1",
        status: "failed",
        error: "Worker process is not running",
      });

      // Verify delivery was updated to failed
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          error: "Worker process is not running",
          durationMs: expect.any(Number),
        }),
      );
    });

    it("does not require board authentication for webhook endpoint", async () => {
      // Webhooks come from external systems, not the board UI.
      // The route does not call assertBoard().
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      // Use an agent actor to prove it's not rejected with 403
      const webhookDeps = { workerManager: mockWorkerManager as any };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "agent",
          companyId: "c1",
          agentId: "a1",
        };
        next();
      });
      app.use(pluginRoutes(mockDb as any, loader as any, undefined, webhookDeps));

      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      // Should not get 403 — webhook routes don't require board access
      expect(res.status).not.toBe(403);
    });

    it("returns 400 when plugin manifest is missing (null)", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({
          id: "p1",
          status: "ready",
          manifestJson: null,
        }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/manifest.*missing/i);
    });

    it("resolves plugin by key when ID lookup fails", async () => {
      // Slug "acme.test" is not a UUID, so resolvePlugin tries getByKey first
      registry.getByKey.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/acme.test/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(200);
      expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
      expect(res.body).toMatchObject({
        deliveryId: "delivery-uuid-1",
        status: "success",
      });
    });

    it("handles empty body when no Content-Type is set", async () => {
      // Express 5 gives undefined body when there is no Content-Type header.
      // The route must handle this gracefully.
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        // supertest .send() without args sends empty body without Content-Type
        .set("Content-Length", "0");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        deliveryId: "delivery-uuid-1",
        status: "success",
      });

      // Verify DB insert recorded empty payload
      expect(mockDbValues).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "p1",
          webhookKey: "github-push",
          status: "pending",
          payload: {},
        }),
      );
    });

    it("passes correct webhook input to the worker RPC", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const payload = { action: "opened", pr: { number: 42 } };
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", "abc-123")
        .send(payload);

      expect(res.status).toBe(200);

      // Verify the full shape of the RPC arguments
      expect(mockWorkerManager.call).toHaveBeenCalledWith(
        "p1",
        "handleWebhook",
        expect.objectContaining({
          endpointKey: "github-push",
          rawBody: JSON.stringify(payload),
          parsedBody: payload,
          requestId: expect.any(String),
        }),
      );

      // Verify headers are passed through (including custom ones)
      const rpcArgs = mockWorkerManager.call.mock.calls[0][2];
      expect(rpcArgs.headers).toHaveProperty("x-github-event", "pull_request");
      expect(rpcArgs.headers).toHaveProperty("x-github-delivery", "abc-123");
    });

    it("records delivery with startedAt timestamp and correct webhook key", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      // Verify the insert includes startedAt and correct fields
      expect(mockDbValues).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "p1",
          webhookKey: "github-push",
          status: "pending",
          startedAt: expect.any(Date),
          headers: expect.any(Object),
          payload: expect.objectContaining({ event: "push" }),
        }),
      );
    });

    it("records finishedAt and durationMs on success", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(200);

      // Verify the update includes finishedAt and durationMs
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          durationMs: expect.any(Number),
          finishedAt: expect.any(Date),
        }),
      );
    });

    it("records finishedAt and durationMs on failure", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);
      mockWorkerManager.call.mockRejectedValueOnce(new Error("Timeout"));

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(502);

      // Verify the update includes finishedAt, durationMs, and error on failure
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          durationMs: expect.any(Number),
          finishedAt: expect.any(Date),
          error: "Timeout",
        }),
      );
    });

    it("coerces non-Error thrown values to string", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);
      // Simulate throwing a non-Error value (e.g. a string)
      mockWorkerManager.call.mockRejectedValueOnce("connection refused");

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({
        deliveryId: "delivery-uuid-1",
        status: "failed",
        error: "connection refused",
      });

      // Verify the DB also records the string error
      expect(mockDbSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          error: "connection refused",
        }),
      );
    });

    it("selects the correct webhook from multiple declarations", async () => {
      const multiWebhookPlugin = createMockPlugin({
        id: "p1",
        status: "ready",
        manifestJson: {
          id: "acme.test",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Test Plugin",
          description: "A test plugin with multiple webhooks",
          author: "Test Author",
          categories: ["connector"],
          capabilities: ["webhooks.receive"],
          entrypoints: { worker: "./worker.js" },
          webhooks: [
            { endpointKey: "github-push", displayName: "GitHub Push" },
            { endpointKey: "github-pr", displayName: "GitHub PR" },
            { endpointKey: "stripe-payment", displayName: "Stripe Payment" },
          ],
        },
      });
      registry.getById.mockResolvedValueOnce(multiWebhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-pr")
        .send({ action: "opened" });

      expect(res.status).toBe(200);

      // Verify the correct endpointKey was dispatched to the worker
      expect(mockWorkerManager.call).toHaveBeenCalledWith(
        "p1",
        "handleWebhook",
        expect.objectContaining({ endpointKey: "github-pr" }),
      );

      // Verify the correct webhook key was recorded in delivery
      expect(mockDbValues).toHaveBeenCalledWith(
        expect.objectContaining({ webhookKey: "github-pr" }),
      );
    });

    it("returns 400 when plugin capabilities array is empty", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({
          id: "p1",
          status: "ready",
          manifestJson: {
            id: "acme.test",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Test Plugin",
            description: "Plugin with empty capabilities",
            author: "Test Author",
            categories: ["connector"],
            capabilities: [],
            entrypoints: { worker: "./worker.js" },
            webhooks: [{ endpointKey: "github-push", displayName: "GitHub Push" }],
          },
        }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/webhooks\.receive/);
    });

    it("returns 400 when manifest has no capabilities field (defaults to empty)", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({
          id: "p1",
          status: "ready",
          manifestJson: {
            id: "acme.test",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Test Plugin",
            description: "Plugin with no capabilities key",
            author: "Test Author",
            categories: ["connector"],
            // capabilities intentionally omitted to test ?? [] fallback
            entrypoints: { worker: "./worker.js" },
            webhooks: [{ endpointKey: "github-push", displayName: "GitHub Push" }],
          },
        }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/webhooks\.receive/);
    });

    it("returns 404 when manifest has no webhooks declarations (defaults to empty)", async () => {
      registry.getById.mockResolvedValueOnce(
        createMockPlugin({
          id: "p1",
          status: "ready",
          manifestJson: {
            id: "acme.test",
            apiVersion: 1,
            version: "1.0.0",
            displayName: "Test Plugin",
            description: "Plugin with capability but no webhook declarations",
            author: "Test Author",
            categories: ["connector"],
            capabilities: ["webhooks.receive"],
            entrypoints: { worker: "./worker.js" },
            // webhooks intentionally omitted to test ?? [] fallback
          },
        }),
      );

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/github-push.*not declared/i);
    });

    it("normalizes array headers to comma-separated strings in delivery record", async () => {
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      // Supertest doesn't natively support sending duplicate headers easily,
      // but we can verify that the route captures headers from req.headers
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .set("X-Custom-Header", "value1")
        .set("X-Another-Header", "value2")
        .send({ event: "push" });

      expect(res.status).toBe(200);

      // Verify headers were included in the delivery record
      const insertArgs = mockDbValues.mock.calls[0][0];
      expect(insertArgs.headers).toHaveProperty("x-custom-header", "value1");
      expect(insertArgs.headers).toHaveProperty("x-another-header", "value2");
    });

    it("delivery insert returns the delivery ID used in response", async () => {
      const customDeliveryId = "custom-delivery-id-abc";
      mockDbReturning.mockResolvedValueOnce([{ id: customDeliveryId }]);
      registry.getById.mockResolvedValueOnce(webhookPlugin);

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(200);
      expect(res.body.deliveryId).toBe(customDeliveryId);
    });

    it("delivery ID is included in failure response too", async () => {
      const customDeliveryId = "fail-delivery-id-xyz";
      mockDbReturning.mockResolvedValueOnce([{ id: customDeliveryId }]);
      registry.getById.mockResolvedValueOnce(webhookPlugin);
      mockWorkerManager.call.mockRejectedValueOnce(new Error("boom"));

      const app = createWebhookApp();
      const res = await request(app)
        .post("/plugins/p1/webhooks/github-push")
        .send({ event: "push" });

      expect(res.status).toBe(502);
      expect(res.body.deliveryId).toBe(customDeliveryId);
      expect(res.body.error).toBe("boom");
    });
  });

  // ===========================================================================
  // Bridge routes (getData / performAction proxy)
  // ===========================================================================

  describe("bridge routes", () => {
    function createBridgeApp() {
      const bridgeDeps: PluginRouteBridgeDeps = {
        workerManager: mockWorkerManager as any,
      };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          source: "session",
          userId: "u_board",
          isInstanceAdmin: true,
          companyIds: ["c1"],
        };
        next();
      });
      app.use(pluginRoutes(mockDb as any, loader as any, undefined, undefined, undefined, bridgeDeps));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status) || 500
          : 500;
        const message = error instanceof Error ? error.message : "Unexpected error";
        res.status(status).json({ error: message });
      });
      return app;
    }

    const readyPlugin = createMockPlugin({
      id: "p1",
      pluginKey: "acme.test",
      status: "ready",
    });

    // -----------------------------------------------------------------------
    // POST /plugins/:pluginId/bridge/data
    // -----------------------------------------------------------------------

    describe("POST /plugins/:pluginId/bridge/data", () => {
      it("returns 501 when bridge deps are not configured", async () => {
        // Note: no getById mock needed — the route returns 501 before resolving
        // the plugin because createApp() doesn't inject bridgeDeps.
        const app = createApp("board");
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(501);
        expect(res.body.error).toMatch(/bridge.*not enabled/i);
      });

      it("returns 404 when plugin is not found", async () => {
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/unknown/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(404);
      });

      it("returns 502 with WORKER_UNAVAILABLE when plugin is not ready", async () => {
        registry.getById.mockResolvedValueOnce(
          createMockPlugin({ id: "p1", status: "installed" }),
        );
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("returns 400 when key is missing", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/key/i);
      });

      it("returns 400 when key is not a string", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: 123 });

        expect(res.status).toBe(400);
      });

      it("proxies getData to the worker and returns data", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ syncedCount: 42, trend: "up" });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health", params: { companyId: "c1" } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { syncedCount: 42, trend: "up" } });
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "getData",
          { key: "sync-health", params: { companyId: "c1" }, renderEnvironment: null },
        );
      });

      it("defaults params to {} when not provided", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "status" });

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "getData",
          { key: "status", params: {}, renderEnvironment: null },
        );
      });

      it("maps JsonRpcCallError with WORKER_ERROR code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
            message: "handler threw",
            data: { stack: "Error at ..." },
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({
          code: "WORKER_ERROR",
          message: "handler threw",
          details: { stack: "Error at ..." },
        });
      });

      it("maps JsonRpcCallError with TIMEOUT code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: "timed out after 30000ms",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("TIMEOUT");
      });

      it("maps generic 'not running' error to WORKER_UNAVAILABLE", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new Error('Cannot call "getData" — worker for "p1" is not running'),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("maps unknown errors to UNKNOWN code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new Error("Something unexpected happened"),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "sync-health" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("UNKNOWN");
        expect(res.body.message).toBe("Something unexpected happened");
      });

      it("resolves plugin by key when ID lookup fails", async () => {
        registry.getById.mockResolvedValueOnce(null);
        registry.getByKey.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/acme.test/bridge/data")
          .send({ key: "status" });

        expect(res.status).toBe(200);
        expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
      });

      it("rejects agent actor", async () => {
        const bridgeDeps: PluginRouteBridgeDeps = { workerManager: mockWorkerManager as any };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "agent", companyId: "c1", agentId: "a1" };
          next();
        });
        app.use(pluginRoutes(mockDb as any, loader as any, undefined, undefined, undefined, bridgeDeps));
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          const status = typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status) || 500
            : 500;
          const message = error instanceof Error ? error.message : "Unexpected error";
          res.status(status).json({ error: message });
        });

        const res = await request(app)
          .post("/plugins/p1/bridge/data")
          .send({ key: "status" });

        expect(res.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // POST /plugins/:pluginId/bridge/action
    // -----------------------------------------------------------------------

    describe("POST /plugins/:pluginId/bridge/action", () => {
      it("returns 501 when bridge deps are not configured", async () => {
        // Note: no getById mock needed — the route returns 501 before resolving
        // the plugin because createApp() doesn't inject bridgeDeps.
        const app = createApp("board");
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "resync" });

        expect(res.status).toBe(501);
      });

      it("returns 404 when plugin is not found", async () => {
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/unknown/bridge/action")
          .send({ key: "resync" });

        expect(res.status).toBe(404);
      });

      it("returns 502 with WORKER_UNAVAILABLE when plugin is not ready", async () => {
        registry.getById.mockResolvedValueOnce(
          createMockPlugin({ id: "p1", status: "error" }),
        );
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "resync" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("returns 400 when key is missing", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({});

        expect(res.status).toBe(400);
      });

      it("proxies performAction to the worker and returns data", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ success: true, count: 5 });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "resync", params: { companyId: "c1" } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { success: true, count: 5 } });
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "performAction",
          { key: "resync", params: { companyId: "c1" }, renderEnvironment: null },
        );
      });

      it("defaults params to {} when not provided", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce(null);

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "reset" });

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "performAction",
          { key: "reset", params: {}, renderEnvironment: null },
        );
      });

      it("maps CAPABILITY_DENIED errors", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
            message: "Missing capability: ui.action.register",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "resync" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("CAPABILITY_DENIED");
      });

      it("maps WORKER_UNAVAILABLE errors", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: "Worker process exited",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/bridge/action")
          .send({ key: "resync" });

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });
    });

    // -----------------------------------------------------------------------
    // POST /plugins/:pluginId/data/:key (URL-keyed getData)
    // -----------------------------------------------------------------------

    describe("POST /plugins/:pluginId/data/:key", () => {
      it("returns 501 when bridge deps are not configured", async () => {
        const app = createApp("board");
        const res = await request(app)
          .post("/plugins/p1/data/sync-health")
          .send({});

        expect(res.status).toBe(501);
        expect(res.body.error).toMatch(/bridge.*not enabled/i);
      });

      it("returns 404 when plugin is not found", async () => {
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/unknown/data/sync-health")
          .send({});

        expect(res.status).toBe(404);
      });

      it("returns 502 with WORKER_UNAVAILABLE when plugin is not ready", async () => {
        registry.getById.mockResolvedValueOnce(
          createMockPlugin({ id: "p1", status: "installed" }),
        );
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/sync-health")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("proxies getData to the worker using key from URL", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ syncedCount: 42, trend: "up" });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/sync-health")
          .send({ params: { companyId: "c1" } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { syncedCount: 42, trend: "up" } });
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "getData",
          { key: "sync-health", params: { companyId: "c1" }, renderEnvironment: null },
        );
      });

      it("defaults params to {} when body is empty", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/status")
          .send({});

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "getData",
          { key: "status", params: {}, renderEnvironment: null },
        );
      });

      it("forwards renderEnvironment metadata to the worker", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/status")
          .send({
            renderEnvironment: {
              environment: "hostOverlay",
              launcherId: "sync-modal",
              bounds: "wide",
            },
          });

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "getData",
          {
            key: "status",
            params: {},
            renderEnvironment: {
              environment: "hostOverlay",
              launcherId: "sync-modal",
              bounds: "wide",
            },
          },
        );
      });

      it("returns 403 when the plugin is not enabled for the provided company", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        registry.getCompanyAvailability.mockResolvedValueOnce({
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.test",
          pluginDisplayName: "Test Plugin",
          pluginStatus: "ready",
          available: false,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/status")
          .send({ companyId: "c1" });

        expect(res.status).toBe(403);
        expect(mockWorkerManager.call).not.toHaveBeenCalled();
      });

      it("maps JsonRpcCallError with WORKER_ERROR code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
            message: "handler threw",
            data: { stack: "Error at ..." },
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/sync-health")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({
          code: "WORKER_ERROR",
          message: "handler threw",
          details: { stack: "Error at ..." },
        });
      });

      it("maps JsonRpcCallError with TIMEOUT code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.TIMEOUT,
            message: "timed out after 30000ms",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/data/sync-health")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("TIMEOUT");
      });

      it("resolves plugin by key when ID lookup fails", async () => {
        registry.getById.mockResolvedValueOnce(null);
        registry.getByKey.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/acme.test/data/status")
          .send({});

        expect(res.status).toBe(200);
        expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
      });

      it("rejects agent actor", async () => {
        const bridgeDeps: PluginRouteBridgeDeps = { workerManager: mockWorkerManager as any };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "agent", companyId: "c1", agentId: "a1" };
          next();
        });
        app.use(pluginRoutes(mockDb as any, loader as any, undefined, undefined, undefined, bridgeDeps));
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          const status = typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status) || 500
            : 500;
          const message = error instanceof Error ? error.message : "Unexpected error";
          res.status(status).json({ error: message });
        });

        const res = await request(app)
          .post("/plugins/p1/data/status")
          .send({});

        expect(res.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // POST /plugins/:pluginId/actions/:key (URL-keyed performAction)
    // -----------------------------------------------------------------------

    describe("POST /plugins/:pluginId/actions/:key", () => {
      it("returns 501 when bridge deps are not configured", async () => {
        const app = createApp("board");
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(501);
      });

      it("returns 404 when plugin is not found", async () => {
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/unknown/actions/resync")
          .send({});

        expect(res.status).toBe(404);
      });

      it("returns 502 with WORKER_UNAVAILABLE when plugin is not ready", async () => {
        registry.getById.mockResolvedValueOnce(
          createMockPlugin({ id: "p1", status: "error" }),
        );
        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("proxies performAction to the worker using key from URL", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ success: true, count: 5 });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({ params: { companyId: "c1" } });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { success: true, count: 5 } });
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "performAction",
          { key: "resync", params: { companyId: "c1" }, renderEnvironment: null },
        );
      });

      it("defaults params to {} when body is empty", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce(null);

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/reset")
          .send({});

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "performAction",
          { key: "reset", params: {}, renderEnvironment: null },
        );
      });

      it("forwards renderEnvironment metadata to the worker", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/reset")
          .send({
            renderEnvironment: {
              environment: "hostOverlay",
              launcherId: "sync-modal",
              bounds: "wide",
            },
          });

        expect(res.status).toBe(200);
        expect(mockWorkerManager.call).toHaveBeenCalledWith(
          "p1",
          "performAction",
          {
            key: "reset",
            params: {},
            renderEnvironment: {
              environment: "hostOverlay",
              launcherId: "sync-modal",
              bounds: "wide",
            },
          },
        );
      });

      it("returns 403 when the plugin is not enabled for the provided company", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        registry.getCompanyAvailability.mockResolvedValueOnce({
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.test",
          pluginDisplayName: "Test Plugin",
          pluginStatus: "ready",
          available: false,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/reset")
          .send({ companyId: "c1" });

        expect(res.status).toBe(403);
        expect(mockWorkerManager.call).not.toHaveBeenCalled();
      });

      it("maps CAPABILITY_DENIED errors", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
            message: "Missing capability: ui.action.register",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("CAPABILITY_DENIED");
      });

      it("maps WORKER_UNAVAILABLE errors", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new JsonRpcCallError({
            code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
            message: "Worker process exited",
          }),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("maps generic 'not running' error to WORKER_UNAVAILABLE", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new Error('Cannot call "performAction" — worker for "p1" is not running'),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("maps generic 'not registered' error to WORKER_UNAVAILABLE", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new Error('Worker for "p1" is not registered'),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("WORKER_UNAVAILABLE");
      });

      it("maps unknown errors to UNKNOWN code", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce(
          new Error("Something completely unexpected"),
        );

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("UNKNOWN");
        expect(res.body.message).toBe("Something completely unexpected");
      });

      it("maps non-Error thrown values to UNKNOWN", async () => {
        registry.getById.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockRejectedValueOnce("string error");

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(502);
        expect(res.body.code).toBe("UNKNOWN");
        expect(res.body.message).toBe("string error");
      });

      it("resolves plugin by key when ID lookup fails", async () => {
        registry.getById.mockResolvedValueOnce(null);
        registry.getByKey.mockResolvedValueOnce(readyPlugin);
        mockWorkerManager.call.mockResolvedValueOnce({ ok: true });

        const app = createBridgeApp();
        const res = await request(app)
          .post("/plugins/acme.test/actions/resync")
          .send({});

        expect(res.status).toBe(200);
        expect(registry.getByKey).toHaveBeenCalledWith("acme.test");
      });

      it("rejects agent actor", async () => {
        const bridgeDeps: PluginRouteBridgeDeps = { workerManager: mockWorkerManager as any };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
          req.actor = { type: "agent", companyId: "c1", agentId: "a1" };
          next();
        });
        app.use(pluginRoutes(mockDb as any, loader as any, undefined, undefined, undefined, bridgeDeps));
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          const status = typeof error === "object" && error !== null && "status" in error
            ? Number((error as { status: unknown }).status) || 500
            : 500;
          const message = error instanceof Error ? error.message : "Unexpected error";
          res.status(status).json({ error: message });
        });

        const res = await request(app)
          .post("/plugins/p1/actions/resync")
          .send({});

        expect(res.status).toBe(403);
      });
    });
  });

  // ===========================================================================
  // Tool discovery and execution routes
  // ===========================================================================

  describe("tool routes", () => {
    const mockToolDispatcher = {
      listToolsForAgent: vi.fn(),
      getTool: vi.fn(),
      executeTool: vi.fn(),
    };

    function createToolApp(actorType: "board" | "agent" = "board") {
      const toolDeps: PluginRouteToolDeps = {
        toolDispatcher: mockToolDispatcher as any,
      };
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = actorType === "board"
          ? {
              type: "board",
              source: "session",
              userId: "u_board",
              isInstanceAdmin: true,
              companyIds: ["c1"],
            }
          : {
              type: "agent",
              companyId: "c1",
              agentId: "a1",
            };
        next();
      });
      app.use(pluginRoutes({} as never, loader as any, undefined, undefined, toolDeps));
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        const status = typeof error === "object" && error !== null && "status" in error
          ? Number((error as { status: unknown }).status) || 500
          : 500;
        const message = error instanceof Error ? error.message : "Unexpected error";
        res.status(status).json({ error: message });
      });
      return app;
    }

    beforeEach(() => {
      mockToolDispatcher.listToolsForAgent.mockReturnValue([]);
      mockToolDispatcher.getTool.mockReturnValue(null);
      mockToolDispatcher.executeTool.mockResolvedValue({ output: "ok" });
    });

    // -----------------------------------------------------------------------
    // GET /plugins/tools
    // -----------------------------------------------------------------------

    describe("GET /plugins/tools", () => {
      it("returns 501 when tool deps are not configured", async () => {
        const app = createApp("board");
        const res = await request(app).get("/plugins/tools");

        expect(res.status).toBe(501);
        expect(res.body).toEqual({ error: "Plugin tool dispatch is not enabled" });
      });

      it("returns empty list when no tools are available", async () => {
        mockToolDispatcher.listToolsForAgent.mockReturnValue([]);

        const app = createToolApp();
        const res = await request(app).get("/plugins/tools");

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(mockToolDispatcher.listToolsForAgent).toHaveBeenCalledWith(undefined);
      });

      it("returns tool list for all plugins", async () => {
        const tools = [
          {
            name: "acme.linear:search-issues",
            displayName: "Search Issues",
            description: "Search Linear issues",
            pluginId: "p1",
          },
          {
            name: "acme.github:list-prs",
            displayName: "List PRs",
            description: "List GitHub pull requests",
            pluginId: "p2",
          },
        ];
        mockToolDispatcher.listToolsForAgent.mockReturnValue(tools);

        const app = createToolApp();
        const res = await request(app).get("/plugins/tools");

        expect(res.status).toBe(200);
        expect(res.body).toEqual(tools);
        expect(mockToolDispatcher.listToolsForAgent).toHaveBeenCalledWith(undefined);
      });

      it("filters tools by pluginId when query param is provided", async () => {
        const tools = [
          {
            name: "acme.linear:search-issues",
            displayName: "Search Issues",
            description: "Search Linear issues",
            pluginId: "p1",
          },
        ];
        mockToolDispatcher.listToolsForAgent.mockReturnValue(tools);

        const app = createToolApp();
        const res = await request(app).get("/plugins/tools?pluginId=p1");

        expect(res.status).toBe(200);
        expect(res.body).toEqual(tools);
        expect(mockToolDispatcher.listToolsForAgent).toHaveBeenCalledWith({ pluginId: "p1" });
      });

      it("filters tools by company-scoped plugin availability when companyId is provided", async () => {
        mockToolDispatcher.listToolsForAgent.mockReturnValue([
          {
            name: "acme.linear:search-issues",
            displayName: "Search Issues",
            description: "Search Linear issues",
            pluginId: "p1",
          },
          {
            name: "acme.github:list-prs",
            displayName: "List PRs",
            description: "List GitHub pull requests",
            pluginId: "p2",
          },
        ]);
        registry.listCompanyAvailability.mockResolvedValueOnce([
          {
            companyId: "c1",
            pluginId: "p1",
            pluginKey: "acme.linear",
            pluginDisplayName: "Linear",
            pluginStatus: "ready",
            available: true,
            settingsJson: {},
            lastError: null,
            createdAt: null,
            updatedAt: null,
          },
        ]);

        const app = createToolApp();
        const res = await request(app).get("/plugins/tools?companyId=c1");

        expect(res.status).toBe(200);
        expect(registry.listCompanyAvailability).toHaveBeenCalledWith("c1", { available: true });
        expect(res.body).toEqual([
          {
            name: "acme.linear:search-issues",
            displayName: "Search Issues",
            description: "Search Linear issues",
            pluginId: "p1",
          },
        ]);
      });

      it("rejects agent access", async () => {
        const app = createToolApp("agent");
        const res = await request(app).get("/plugins/tools");

        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: "Board access required" });
      });
    });

    // -----------------------------------------------------------------------
    // POST /plugins/tools/execute
    // -----------------------------------------------------------------------

    describe("POST /plugins/tools/execute", () => {
      const validRunContext = {
        agentId: "a1",
        runId: "r1",
        companyId: "c1",
        projectId: "proj1",
      };

      it("returns 501 when tool deps are not configured", async () => {
        const app = createApp("board");
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            parameters: { query: "bug" },
            runContext: validRunContext,
          });

        expect(res.status).toBe(501);
        expect(res.body).toEqual({ error: "Plugin tool dispatch is not enabled" });
      });

      it("returns 400 when request body is empty", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .set("Content-Length", "0");

        expect(res.status).toBe(400);
      });

      it("returns 400 when tool is missing", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({ runContext: validRunContext });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/tool.*required/i);
      });

      it("returns 400 when tool is not a string", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({ tool: 123, runContext: validRunContext });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/tool.*required.*string/i);
      });

      it("returns 400 when runContext is missing", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({ tool: "acme.linear:search-issues" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/runContext.*required/i);
      });

      it("returns 400 when runContext is not an object", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({ tool: "acme.linear:search-issues", runContext: "not-object" });

        expect(res.status).toBe(400);
      });

      it("returns 400 when runContext is missing required fields", async () => {
        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: { agentId: "a1" }, // missing runId, companyId, projectId
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/agentId.*runId.*companyId.*projectId/);
      });

      it("returns 404 when tool is not found", async () => {
        mockToolDispatcher.getTool.mockReturnValue(null);

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.nonexistent:missing-tool",
            runContext: validRunContext,
          });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("executes tool successfully", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockResolvedValue({
          output: "Found 3 issues",
          data: { count: 3 },
        });

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            parameters: { query: "bug" },
            runContext: validRunContext,
          });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          output: "Found 3 issues",
          data: { count: 3 },
        });
        expect(mockToolDispatcher.executeTool).toHaveBeenCalledWith(
          "acme.linear:search-issues",
          { query: "bug" },
          validRunContext,
        );
      });

      it("returns 403 when the tool's plugin is not enabled for the target company", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        registry.getCompanyAvailability.mockResolvedValueOnce({
          companyId: "c1",
          pluginId: "p1",
          pluginKey: "acme.test",
          pluginDisplayName: "Test Plugin",
          pluginStatus: "ready",
          available: false,
          settingsJson: {},
          lastError: null,
          createdAt: null,
          updatedAt: null,
        });

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(403);
        expect(mockToolDispatcher.executeTool).not.toHaveBeenCalled();
        expect(res.body.error).toMatch(/not enabled.*c1/i);
      });

      it("defaults parameters to {} when not provided", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockResolvedValue({ output: "ok" });

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(200);
        expect(mockToolDispatcher.executeTool).toHaveBeenCalledWith(
          "acme.linear:search-issues",
          {},
          validRunContext,
        );
      });

      it("returns 502 when worker is not running", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockRejectedValue(
          new Error("Worker for plugin p1 is not running"),
        );

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/not running/i);
      });

      it("returns 502 when worker error contains 'worker' keyword", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockRejectedValue(
          new Error("worker process crashed unexpectedly"),
        );

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(502);
      });

      it("returns 500 for non-worker errors", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockRejectedValue(
          new Error("Database connection failed"),
        );

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe("Database connection failed");
      });

      it("coerces non-Error thrown values to string", async () => {
        mockToolDispatcher.getTool.mockReturnValue({
          name: "acme.linear:search-issues",
          pluginId: "p1",
        });
        mockToolDispatcher.executeTool.mockRejectedValue("raw string error");

        const app = createToolApp();
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(500);
        expect(res.body.error).toBe("raw string error");
      });

      it("rejects agent access", async () => {
        const app = createToolApp("agent");
        const res = await request(app)
          .post("/plugins/tools/execute")
          .send({
            tool: "acme.linear:search-issues",
            runContext: validRunContext,
          });

        expect(res.status).toBe(403);
      });
    });
  });
});
