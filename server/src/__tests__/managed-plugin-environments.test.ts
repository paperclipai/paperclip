import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environments,
  instanceSettings,
  plugins,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.js";
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "../services/managed-config.js";
import { applyManagedEnvironments } from "../services/managed-environments.js";

const PLUGIN_KEY = "example.remote-host-plugin";
const MARKER = `${PLUGIN_KEY}:tasks`;

type ReadyListener = (payload: { pluginId: string }) => void;

function managedConfig(entries: unknown[]) {
  return parseManagedConfigEnv({
    [MANAGED_CONFIG_ENV_KEY]: JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.1106.0",
      features: {},
      plugins: { autoInstall: ["remote-host"] },
      environments: entries,
    }),
  });
}

const remoteHostEntry = {
  name: "Remote Host",
  description: "Runs the agent on a remote host",
  driver: "plugin",
  pluginKey: PLUGIN_KEY,
  driverKey: "tasks",
  driverConfig: {},
};

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("managed plugin environment rows", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let pluginId: string;
  let running: boolean;
  const call = vi.fn(async (_id: string, method: string, input: { config: Record<string, unknown> }) =>
    method === "environmentValidateConfig" ? { ok: true, normalizedConfig: { ...input.config, normalized: true } } : null);
  let readyListeners: ReadyListener[] = [];
  const workerManager = {
    isRunning: vi.fn(() => running),
    call,
    getWorker: vi.fn(() => ({
      on: (_event: "ready", listener: ReadyListener) => { readyListeners.push(listener); },
      off: (_event: "ready", listener: ReadyListener) => {
        readyListeners = readyListeners.filter((candidate) => candidate !== listener);
      },
    })),
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-managed-plugin-environment-rows-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    running = true;
    readyListeners = [];
    call.mockClear();
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companies);
    pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: PLUGIN_KEY,
      packageName: "@example/remote-host-plugin",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }],
      } as never,
    });
  });

  const ensure = (overrides: Record<string, unknown> = {}) =>
    environmentService(db).ensureManagedPluginEnvironment({
      name: "Remote Host",
      description: "Runs the agent on a remote host",
      pluginKey: PLUGIN_KEY,
      driverKey: "tasks",
      driverConfig: {},
      workerManager,
      ...overrides,
    });
  const pluginRows = () => db.select().from(environments).where(eq(environments.driver, "plugin"));
  const company = async () => {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Managed", issuePrefix: `M${id.slice(0, 7)}` });
    return id;
  };

  it("creates the marked row through the plugin validator, then changes nothing", async () => {
    await company();
    const first = await ensure();
    expect(first.action).toBe("added");
    expect(first.environment).toMatchObject({
      name: "Remote Host",
      description: "Runs the agent on a remote host",
      driver: "plugin",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: { normalized: true } },
      metadata: { managedByPaperclip: true, managedPluginEnvironment: MARKER },
    });
    expect(call).toHaveBeenCalledWith(pluginId, "environmentValidateConfig", { driverKey: "tasks", config: {} });
    expect(await db.select().from(activityLog)).toHaveLength(1);

    const second = await ensure();
    const rows = await pluginRows();
    expect(second.action).toBe("unchanged");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedAt.getTime()).toBe(first.environment.updatedAt.getTime());
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("adopts a hand-made row for the same plugin and driver, keeping its agents", async () => {
    const companyId = await company();
    const [handMade] = await db.insert(environments).values({
      name: "Remote Host (manual)",
      driver: "plugin",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
      metadata: { note: "made by hand" },
    }).returning();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process", defaultEnvironmentId: handMade!.id });

    const result = await ensure();
    const rows = await pluginRows();
    expect(result.action).toBe("adopted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: handMade!.id,
      name: "Remote Host",
      metadata: { note: "made by hand", managedByPaperclip: true, managedPluginEnvironment: MARKER },
    });
    const [kept] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(kept!.defaultEnvironmentId).toBe(handMade!.id);
  });

  it("adopts a row again after its markers were cleared", async () => {
    const first = await ensure();
    // What the route's marker-clear request stores.
    await db.update(environments)
      .set({ metadata: { managedByPaperclip: null, managedPluginEnvironment: null } })
      .where(eq(environments.id, first.environment.id));

    const again = await ensure();
    expect(again.action).toBe("adopted");
    expect(again.environment.id).toBe(first.environment.id);
    expect(await pluginRows()).toHaveLength(1);
  });

  it("lets several rows hold a cleared marker", async () => {
    const config = { pluginKey: PLUGIN_KEY, driverKey: "other", driverConfig: {} };
    await db.insert(environments).values([
      { name: "Cleared one", driver: "plugin", status: "active", config, metadata: { managedPluginEnvironment: false } },
      { name: "Cleared two", driver: "plugin", status: "active", config, metadata: { managedPluginEnvironment: false } },
      { name: "Cleared three", driver: "plugin", status: "active", config, metadata: { managedPluginEnvironment: null } },
    ]);
    expect(await pluginRows()).toHaveLength(3);
  });

  it("archives the active marked row and reactivates it on the next ensure", async () => {
    await ensure();
    const archived = await environmentService(db).archiveManagedPluginEnvironment({ pluginKey: PLUGIN_KEY, driverKey: "tasks" });
    expect(archived?.status).toBe("archived");
    expect(await environmentService(db).archiveManagedPluginEnvironment({ pluginKey: PLUGIN_KEY, driverKey: "tasks" })).toBeNull();
    expect((await environmentService(db).findManagedPluginEnvironment({ pluginKey: PLUGIN_KEY, driverKey: "tasks" }))?.status)
      .toBe("archived");

    const reactivated = await ensure();
    expect(reactivated.action).toBe("updated");
    expect(reactivated.environment.status).toBe("active");
  });

  it("refuses to ensure while the plugin has no running worker", async () => {
    running = false;
    await expect(ensure()).rejects.toThrow(/has no running worker/);
    expect(await pluginRows()).toHaveLength(0);
  });

  it("refuses to take a name another environment already holds", async () => {
    await db.insert(environments).values({ name: "Remote Host", driver: "ssh", status: "active", config: {} });
    await expect(ensure()).rejects.toThrow(/already exists with driver "ssh"/);
  });

  it("allows at most one row per marker", async () => {
    await ensure();
    await expect(db.insert(environments).values({
      name: "Second remote host",
      driver: "plugin",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
      metadata: { managedPluginEnvironment: MARKER },
    })).rejects.toThrow();
  });

  describe("boot (applyManagedEnvironments)", () => {
    const boot = (entries: unknown[] = [remoteHostEntry]) =>
      applyManagedEnvironments(db, managedConfig(entries), { env: {}, workerManager, autoInstalledPluginKeys: [PLUGIN_KEY] });
    const instanceDefault = async () =>
      (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0]?.defaultEnvironmentId ?? null;

    it("creates the row on the first boot and changes nothing on the second", async () => {
      const first = await boot();
      expect(first).toMatchObject({ ensured: 1, added: 1, failed: 0 });
      const [row] = await pluginRows();
      expect(row).toMatchObject({ name: "Remote Host", status: "active", metadata: { managedByPaperclip: true, managedPluginEnvironment: MARKER } });

      const second = await boot();
      expect(second).toMatchObject({ ensured: 1, added: 0, unchanged: 1 });
      const after = await pluginRows();
      expect(after).toHaveLength(1);
      expect(after[0]!.updatedAt.getTime()).toBe(row!.updatedAt.getTime());
      expect(await instanceDefault()).toBeNull();
    });

    it("archives the row while the plugin is down and reactivates it when the worker recovers", async () => {
      await boot();
      running = false;
      expect(await boot()).toMatchObject({ ensured: 0, failed: 1 });
      expect((await pluginRows())[0]!.status).toBe("archived");

      running = true;
      for (const listener of [...readyListeners]) listener({ pluginId });
      await vi.waitFor(async () => expect((await pluginRows())[0]?.status).toBe("active"));
    });

    it("never archives a row whose entry left the document", async () => {
      await boot();
      expect(await boot([])).toBeNull();
      expect((await pluginRows())[0]!.status).toBe("active");
    });
  });
});
