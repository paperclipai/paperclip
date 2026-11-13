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
import { fillUnsetInstanceDefault } from "../services/managed-instance-default.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";

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
        agentLifecycle: true,
        capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
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

  describe("instanceDefault (fill only an unset default)", () => {
    const defaultEntry = { ...remoteHostEntry, instanceDefault: true };
    const boot = (entries: unknown[] = [defaultEntry]) =>
      applyManagedEnvironments(db, managedConfig(entries), { env: {}, workerManager, autoInstalledPluginKeys: [PLUGIN_KEY] });
    const instanceDefault = async () =>
      (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0]?.defaultEnvironmentId ?? null;
    const setInstanceDefault = async (environmentId: string | null) => {
      const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
      if (row) await db.update(instanceSettings).set({ defaultEnvironmentId: environmentId }).where(eq(instanceSettings.id, row.id));
      else await db.insert(instanceSettings).values({ singletonKey: "default", defaultEnvironmentId: environmentId });
    };
    const sandboxRow = async () => {
      const [row] = await db.insert(environments).values({
        name: "Managed Sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" },
        metadata: { managedByPaperclip: true, managedSandboxProvider: "daytona" },
      }).returning();
      return row!.id;
    };
    const agent = async (companyId: string, defaultEnvironmentId: string | null,
      lifecycle: Partial<Pick<typeof agents.$inferInsert, "lifecycleState" | "lifecycleRequiredPluginIds">> = {}) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name: `Agent ${id}`, adapterType: "process", defaultEnvironmentId, ...lifecycle });
      return id;
    };

    it("makes the plugin row the default on a new instance (unset default)", async () => {
      await boot();
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);
    });

    it("keeps an existing instance's default, which the managed sandbox already filled", async () => {
      const sandboxId = await sandboxRow();
      await setInstanceDefault(sandboxId);
      await agent(await company(), null);
      await boot();
      await boot();
      expect(await instanceDefault()).toBe(sandboxId);
    });

    it("keeps an admin's choice", async () => {
      const [chosen] = await db.insert(environments).values({ name: "Admin choice", driver: "ssh", status: "active", config: {} }).returning();
      await setInstanceDefault(chosen!.id);
      await boot();
      expect(await instanceDefault()).toBe(chosen!.id);
    });

    it("never takes over later when the plugin was down at the first boot and the sandbox filled", async () => {
      running = false;
      await boot();
      expect(await instanceDefault()).toBeNull();
      // The same boot's managed sandbox fill (under managed-sandbox-only).
      const sandboxId = await sandboxRow();
      await fillUnsetInstanceDefault(db, sandboxId);

      // The plugin recovers mid-process, then on a later boot: no fill either way.
      running = true;
      for (const listener of [...readyListeners]) listener({ pluginId });
      await vi.waitFor(async () => expect((await pluginRows())[0]?.status).toBe("active"));
      await boot();
      expect(await instanceDefault()).toBe(sandboxId);
    });

    it("declines an admin-cleared default while an active agent that follows it lacks the plugin's setup", async () => {
      await setInstanceDefault(null);
      await agent(await company(), null);
      await boot();
      expect(await instanceDefault()).toBeNull();
      // The same boot's managed sandbox fill still fills it.
      const sandboxId = await sandboxRow();
      expect(await fillUnsetInstanceDefault(db, sandboxId)).toMatchObject({ filled: true });
      expect(await instanceDefault()).toBe(sandboxId);
    });

    it("declines a local default the same way", async () => {
      const [local] = await db.insert(environments).values({ name: "Local", driver: "local", status: "active", config: {} }).returning();
      await setInstanceDefault(local!.id);
      await agent(await company(), null, { lifecycleState: "verifying" });
      await boot();
      expect(await instanceDefault()).toBe(local!.id);
    });

    it("fills when no active agent following the default needs the plugin's setup", async () => {
      const companyId = await company();
      const sandboxId = await sandboxRow();
      await agent(companyId, null, { lifecycleState: "paused" });
      await agent(companyId, null, { lifecycleRequiredPluginIds: [pluginId] });
      await agent(companyId, sandboxId);
      await setInstanceDefault(null);
      await boot();
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);
    });

    it("does nothing without the flag", async () => {
      await boot([remoteHostEntry]);
      expect(await instanceDefault()).toBeNull();
    });

    it("prepares a new agent that follows the default with the plugin, and one set to the sandbox without it", async () => {
      await boot();
      const sandboxId = await sandboxRow();
      const companyId = await company();
      const selection = async (id: string) =>
        createLifecycleDriver(db, { call } as never)
          .requiredPluginIds((await createLifecycleStore(db, createAgentLifecycleEffects()).get(id))!);
      expect(await selection(await agent(companyId, null))).toEqual([pluginId]);
      expect(await selection(await agent(companyId, sandboxId))).toEqual([]);
    });
  });
});
