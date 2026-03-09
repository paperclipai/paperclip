import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  PaperclipPluginManifestV1,
  PluginStatus,
} from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "acme.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "worker.js" },
    ...overrides,
  };
}

/** Create a mock row representing a persisted plugin. */
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    pluginKey: "acme.test-plugin",
    packageName: "@acme/test-plugin",
    version: "1.0.0",
    apiVersion: 1,
    categories: ["connector"],
    manifestJson: buildManifest(),
    status: "installed" as PluginStatus,
    installOrder: 1,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Create a mock config row. */
function makeConfigRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "config-uuid-1",
    pluginId: "uuid-1",
    configJson: {},
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCompanySettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-settings-uuid-1",
    companyId: "company-uuid-1",
    pluginId: "uuid-1",
    enabled: true,
    settingsJson: { teamId: "team-1" },
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEntityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "entity-uuid-1",
    pluginId: "uuid-1",
    entityType: "project",
    scopeKind: "company",
    scopeId: "company-uuid-1",
    externalId: "ext-1",
    title: "External Project",
    status: "active",
    data: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-uuid-1",
    pluginId: "uuid-1",
    jobKey: "sync",
    schedule: "0 * * * *",
    status: "active",
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeJobRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-uuid-1",
    jobId: "job-uuid-1",
    pluginId: "uuid-1",
    trigger: "schedule",
    status: "pending",
    durationMs: null,
    error: null,
    logs: [],
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeWebhookDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-uuid-1",
    pluginId: "uuid-1",
    webhookKey: "github-push",
    externalId: "ext-delivery-1",
    status: "pending",
    durationMs: null,
    error: null,
    payload: {},
    headers: {},
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

/**
 * Build a mock Drizzle DB object that tracks method calls and allows
 * configuring return values per-test.
 */
function buildMockDb() {
  const state = {
    selectResult: [] as unknown[],
    selectQueue: [] as unknown[][],
    insertResult: [] as unknown[],
    updateResult: [] as unknown[],
    deleteResult: [] as unknown[],
    insertError: null as Error | null,
  };

  // Build a chainable query builder pattern
  const chainable = (resultKey: keyof typeof state) => {
    const chain: any = {};
    const methods = [
      "from", "where", "orderBy", "set", "values", "returning",
      "onConflictDoUpdate", "limit", "offset",
    ];
    for (const method of methods) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = vi.fn((resolve: (val: unknown) => unknown) => {
      const queuedResult = resultKey === "selectResult" && state.selectQueue.length > 0
        ? state.selectQueue.shift() ?? state.selectResult
        : state[resultKey];
      if (resultKey === "insertResult" && state.insertError) {
        return Promise.reject(state.insertError);
      }
      return Promise.resolve(resolve(queuedResult));
    });
    // Allow direct .returning() to resolve
    chain.returning = vi.fn(() => {
      const queuedResult = resultKey === "selectResult" && state.selectQueue.length > 0
        ? state.selectQueue.shift() ?? state.selectResult
        : state[resultKey];
      if (resultKey === "insertResult" && state.insertError) {
        return Promise.reject(state.insertError);
      }
      return Promise.resolve(queuedResult);
    });
    return chain;
  };

  const db = {
    select: vi.fn(() => chainable("selectResult")),
    insert: vi.fn(() => chainable("insertResult")),
    update: vi.fn(() => chainable("updateResult")),
    delete: vi.fn(() => chainable("deleteResult")),
  };

  return { db: db as any, state };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginRegistryService", () => {
  let db: ReturnType<typeof buildMockDb>["db"];
  let state: ReturnType<typeof buildMockDb>["state"];
  let registry: ReturnType<typeof pluginRegistryService>;

  beforeEach(() => {
    const mock = buildMockDb();
    db = mock.db;
    state = mock.state;
    registry = pluginRegistryService(db);
  });

  // =========================================================================
  // list
  // =========================================================================

  describe("list", () => {
    it("calls db.select with orderBy", async () => {
      state.selectResult = [makeRow()];
      const result = await registry.list();
      expect(db.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it("returns empty array when no plugins", async () => {
      state.selectResult = [];
      const result = await registry.list();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // listInstalled
  // =========================================================================

  describe("listInstalled", () => {
    it("returns installed plugins (excludes uninstalled)", async () => {
      state.selectResult = [
        makeRow({ id: "a", status: "ready" }),
        makeRow({ id: "b", status: "error" }),
      ];
      const result = await registry.listInstalled();
      expect(db.select).toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.status)).not.toContain("uninstalled");
    });

    it("returns empty array when no installed plugins", async () => {
      state.selectResult = [];
      const result = await registry.listInstalled();
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // listByStatus
  // =========================================================================

  describe("listByStatus", () => {
    it("filters by the given status", async () => {
      const readyPlugin = makeRow({ status: "ready" });
      state.selectResult = [readyPlugin];
      const result = await registry.listByStatus("ready");
      expect(result).toHaveLength(1);
      expect(db.select).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // company-scoped settings / availability
  // =========================================================================

  describe("company-scoped settings", () => {
    it("upserts company settings by inserting when no row exists", async () => {
      state.selectQueue = [[makeRow()], []];
      state.insertResult = [makeCompanySettingsRow()];

      const result = await registry.upsertCompanySettings("company-uuid-1", "uuid-1", {
        settingsJson: { teamId: "team-1" },
      });

      expect(db.insert).toHaveBeenCalled();
      expect(result.settingsJson).toEqual({ teamId: "team-1" });
    });

    it("lists normalized company availability across installed plugins", async () => {
      state.selectQueue = [[
        makeRow({ id: "uuid-1", pluginKey: "acme.alpha", manifestJson: buildManifest({ id: "acme.alpha", displayName: "Alpha" }) }),
        makeRow({ id: "uuid-2", pluginKey: "acme.beta", manifestJson: buildManifest({ id: "acme.beta", displayName: "Beta" }) }),
      ], [
        makeCompanySettingsRow({ pluginId: "uuid-2", companyId: "company-uuid-1", enabled: false, settingsJson: { teamId: "beta-team" } }),
      ]];

      const result = await registry.listCompanyAvailability("company-uuid-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        companyId: "company-uuid-1",
        pluginId: "uuid-1",
        available: true,
        settingsJson: {},
      });
      expect(result[1]).toMatchObject({
        companyId: "company-uuid-1",
        pluginId: "uuid-2",
        available: false,
        settingsJson: { teamId: "beta-team" },
      });
    });

    it("returns enabled-by-default availability when no company override exists", async () => {
      state.selectQueue = [[makeRow()], []];

      const result = await registry.getCompanyAvailability("company-uuid-1", "uuid-1");

      expect(result).toMatchObject({
        companyId: "company-uuid-1",
        pluginId: "uuid-1",
        available: true,
        settingsJson: {},
        lastError: null,
      });
    });

    it("disables company availability by persisting an explicit disabled override", async () => {
      state.selectQueue = [[makeRow()], [makeCompanySettingsRow()]];
      state.updateResult = [makeCompanySettingsRow({ enabled: false })];

      const result = await registry.updateCompanyAvailability("company-uuid-1", "uuid-1", {
        available: false,
      });

      expect(db.update).toHaveBeenCalled();
      expect(result).toMatchObject({
        companyId: "company-uuid-1",
        pluginId: "uuid-1",
        available: false,
        settingsJson: { teamId: "team-1" },
        lastError: null,
      });
    });

    it("disables company availability by inserting an override when no row exists yet", async () => {
      state.selectQueue = [[makeRow()], []];
      state.insertResult = [makeCompanySettingsRow({
        enabled: false,
        settingsJson: {},
        lastError: null,
      })];

      const result = await registry.updateCompanyAvailability("company-uuid-1", "uuid-1", {
        available: false,
      });

      expect(db.insert).toHaveBeenCalled();
      expect(result).toMatchObject({
        companyId: "company-uuid-1",
        pluginId: "uuid-1",
        available: false,
        settingsJson: {},
        lastError: null,
      });
    });
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe("getById", () => {
    it("returns the plugin when found", async () => {
      const row = makeRow();
      state.selectResult = [row];
      const result = await registry.getById("uuid-1");
      expect(result).toBeTruthy();
      expect(result!.pluginKey).toBe("acme.test-plugin");
    });

    it("returns null when not found", async () => {
      state.selectResult = [];
      const result = await registry.getById("nonexistent");
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // getByKey
  // =========================================================================

  describe("getByKey", () => {
    it("returns the plugin when found", async () => {
      state.selectResult = [makeRow()];
      const result = await registry.getByKey("acme.test-plugin");
      expect(result).toBeTruthy();
    });

    it("returns null when not found", async () => {
      state.selectResult = [];
      const result = await registry.getByKey("nonexistent");
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // install
  // =========================================================================

  describe("install", () => {
    it("inserts a new plugin row with correct fields", async () => {
      const manifest = buildManifest();
      // First getByKey returns null (not already installed)
      state.selectResult = [];
      const newRow = makeRow();
      state.insertResult = [newRow];

      const result = await registry.install(
        { packageName: "@acme/test-plugin" },
        manifest,
      );

      expect(db.insert).toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result.pluginKey).toBe("acme.test-plugin");
    });

    it("throws conflict when plugin already exists (via getByKey check)", async () => {
      const manifest = buildManifest();
      state.selectResult = [makeRow()]; // existing plugin found

      await expect(
        registry.install({ packageName: "@acme/test-plugin" }, manifest),
      ).rejects.toThrow(/already installed/);
    });

    it("reactivates an uninstalled plugin instead of throwing conflict", async () => {
      const manifest = buildManifest({ version: "2.0.0" });
      state.selectResult = [makeRow({ id: "uuid-1", status: "uninstalled" })];
      state.updateResult = [makeRow({ id: "uuid-1", status: "installed", version: "2.0.0" })];

      const result = await registry.install(
        { packageName: "@acme/test-plugin", packagePath: "/tmp/acme-test-plugin" },
        manifest,
      );

      expect(db.update).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result.status).toBe("installed");
      expect(result.version).toBe("2.0.0");
    });

    it("handles unique constraint violation from DB", async () => {
      const manifest = buildManifest();
      state.selectResult = []; // getByKey returns null
      state.insertError = Object.assign(new Error("unique violation"), {
        code: "23505",
        constraint: "plugins_plugin_key_idx",
      });

      await expect(
        registry.install({ packageName: "@acme/test-plugin" }, manifest),
      ).rejects.toThrow(/already installed/);
    });

    it("re-throws non-unique-constraint errors", async () => {
      const manifest = buildManifest();
      state.selectResult = []; // getByKey returns null
      state.insertError = new Error("connection timeout");

      await expect(
        registry.install({ packageName: "@acme/test-plugin" }, manifest),
      ).rejects.toThrow("connection timeout");
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe("update", () => {
    it("updates packageName when provided", async () => {
      state.selectResult = [makeRow()]; // getById finds the plugin
      const updatedRow = makeRow({ packageName: "@acme/new-name" });
      state.updateResult = [updatedRow];

      const result = await registry.update("uuid-1", {
        packageName: "@acme/new-name",
      });

      expect(db.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it("updates manifest fields when manifest is provided", async () => {
      const newManifest = buildManifest({ version: "2.0.0" });
      state.selectResult = [makeRow()];
      state.updateResult = [makeRow({ version: "2.0.0", manifestJson: newManifest })];

      const result = await registry.update("uuid-1", {
        manifest: newManifest,
      });

      expect(result).toBeTruthy();
    });

    it("throws not-found when plugin does not exist", async () => {
      state.selectResult = [];

      await expect(
        registry.update("nonexistent", { version: "2.0.0" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // updateStatus
  // =========================================================================

  describe("updateStatus", () => {
    it("updates status and lastError", async () => {
      state.selectResult = [makeRow()];
      const updatedRow = makeRow({ status: "error", lastError: "crash" });
      state.updateResult = [updatedRow];

      const result = await registry.updateStatus("uuid-1", {
        status: "error",
        lastError: "crash",
      });

      expect(db.update).toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it("clears lastError when not provided", async () => {
      state.selectResult = [makeRow({ status: "error", lastError: "old error" })];
      const updatedRow = makeRow({ status: "ready", lastError: null });
      state.updateResult = [updatedRow];

      const result = await registry.updateStatus("uuid-1", {
        status: "ready",
      });

      expect(result).toBeTruthy();
    });

    it("throws not-found when plugin does not exist", async () => {
      state.selectResult = [];

      await expect(
        registry.updateStatus("nonexistent", { status: "ready" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // uninstall
  // =========================================================================

  describe("uninstall", () => {
    it("soft-deletes by updating status to uninstalled", async () => {
      state.selectResult = [makeRow({ status: "ready" })];
      const uninstalledRow = makeRow({ status: "uninstalled" });
      state.updateResult = [uninstalledRow];

      const result = await registry.uninstall("uuid-1", false);

      expect(db.update).toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it("hard-deletes when removeData is true", async () => {
      state.selectResult = [makeRow({ status: "ready" })];
      state.deleteResult = [makeRow()];

      const result = await registry.uninstall("uuid-1", true);

      expect(db.delete).toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it("throws not-found when plugin does not exist", async () => {
      state.selectResult = [];

      await expect(registry.uninstall("nonexistent")).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // getConfig
  // =========================================================================

  describe("getConfig", () => {
    it("returns config when it exists", async () => {
      state.selectResult = [makeConfigRow()];
      const result = await registry.getConfig("uuid-1");
      expect(result).toBeTruthy();
      expect(result!.pluginId).toBe("uuid-1");
    });

    it("returns null when no config exists", async () => {
      state.selectResult = [];
      const result = await registry.getConfig("uuid-1");
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // upsertConfig
  // =========================================================================

  describe("upsertConfig", () => {
    it("throws not-found when plugin does not exist", async () => {
      state.selectResult = [];

      await expect(
        registry.upsertConfig("nonexistent", { configJson: { key: "val" } }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // =========================================================================
  // setConfigError
  // =========================================================================

  describe("setConfigError", () => {
    it("throws not-found when config does not exist", async () => {
      state.updateResult = []; // no rows updated

      await expect(
        registry.setConfigError("uuid-1", "validation failed"),
      ).rejects.toThrow(/not found/i);
    });

    it("updates config error when config exists", async () => {
      const updatedConfig = makeConfigRow({ lastError: "validation failed" });
      state.updateResult = [updatedConfig];

      const result = await registry.setConfigError("uuid-1", "validation failed");
      expect(result.lastError).toBe("validation failed");
    });
  });

  // =========================================================================
  // deleteConfig
  // =========================================================================

  describe("deleteConfig", () => {
    it("returns the deleted config row", async () => {
      const configRow = makeConfigRow();
      state.deleteResult = [configRow];

      const result = await registry.deleteConfig("uuid-1");
      expect(result).toBeTruthy();
      expect(result!.pluginId).toBe("uuid-1");
    });

    it("returns null when no config exists", async () => {
      state.deleteResult = [];

      const result = await registry.deleteConfig("uuid-1");
      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // Entities
  // =========================================================================

  describe("entities", () => {
    it("listEntities returns entities for a plugin", async () => {
      state.selectResult = [makeEntityRow()];
      const result = await registry.listEntities("uuid-1");
      expect(result).toHaveLength(1);
    });

    it("getEntityByExternalId returns a single entity", async () => {
      state.selectResult = [makeEntityRow()];
      const result = await registry.getEntityByExternalId("uuid-1", "project", "ext-1");
      expect(result).toBeTruthy();
    });

    it("upsertEntity creates a new entity", async () => {
      state.selectResult = []; // not found
      state.insertResult = [makeEntityRow()];
      const result = await registry.upsertEntity("uuid-1", {
        entityType: "project",
        externalId: "ext-1",
        scopeKind: "company",
        scopeId: "company-uuid-1",
        data: {},
      });
      expect(result).toBeTruthy();
      expect(db.insert).toHaveBeenCalled();
    });

    it("upsertEntity updates existing entity", async () => {
      state.selectResult = [makeEntityRow()];
      state.updateResult = [makeEntityRow({ title: "Updated" })];
      const result = await registry.upsertEntity("uuid-1", {
        entityType: "project",
        externalId: "ext-1",
        scopeKind: "company",
        scopeId: "company-uuid-1",
        title: "Updated",
        data: {},
      });
      expect(result.title).toBe("Updated");
      expect(db.update).toHaveBeenCalled();
    });

    it("deleteEntity removes an entity", async () => {
      state.deleteResult = [makeEntityRow()];
      const result = await registry.deleteEntity("entity-uuid-1");
      expect(result).toBeTruthy();
    });
  });

  // =========================================================================
  // Jobs
  // =========================================================================

  describe("jobs", () => {
    it("listJobs returns jobs for a plugin", async () => {
      state.selectResult = [makeJobRow()];
      const result = await registry.listJobs("uuid-1");
      expect(result).toHaveLength(1);
    });

    it("getJobByKey returns a single job", async () => {
      state.selectResult = [makeJobRow()];
      const result = await registry.getJobByKey("uuid-1", "sync");
      expect(result).toBeTruthy();
    });

    it("upsertJob creates a new job", async () => {
      state.selectResult = [];
      state.insertResult = [makeJobRow()];
      const result = await registry.upsertJob("uuid-1", "sync", { schedule: "0 * * * *" });
      expect(result).toBeTruthy();
      expect(db.insert).toHaveBeenCalled();
    });

    it("upsertJob updates existing job", async () => {
      state.selectResult = [makeJobRow()];
      state.updateResult = [makeJobRow({ schedule: "*/5 * * * *" })];
      const result = await registry.upsertJob("uuid-1", "sync", { schedule: "*/5 * * * *" });
      expect(result.schedule).toBe("*/5 * * * *");
      expect(db.update).toHaveBeenCalled();
    });

    it("createJobRun inserts a new job run", async () => {
      state.insertResult = [makeJobRunRow()];
      const result = await registry.createJobRun("uuid-1", "job-uuid-1", "manual");
      expect(result).toBeTruthy();
      expect(db.insert).toHaveBeenCalled();
    });

    it("updateJobRun updates run status", async () => {
      state.updateResult = [makeJobRunRow({ status: "success" })];
      const result = await registry.updateJobRun("run-uuid-1", { status: "success" });
      expect(result.status).toBe("success");
      expect(db.update).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Webhooks
  // =========================================================================

  describe("webhooks", () => {
    it("createWebhookDelivery inserts a new delivery", async () => {
      state.insertResult = [makeWebhookDeliveryRow()];
      const result = await registry.createWebhookDelivery("uuid-1", "push", { payload: {} });
      expect(result).toBeTruthy();
      expect(db.insert).toHaveBeenCalled();
    });

    it("updateWebhookDelivery updates delivery status", async () => {
      state.updateResult = [makeWebhookDeliveryRow({ status: "success" })];
      const result = await registry.updateWebhookDelivery("delivery-uuid-1", { status: "success" });
      expect(result.status).toBe("success");
      expect(db.update).toHaveBeenCalled();
    });
  });
});
