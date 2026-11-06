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
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "../services/managed-config.js";
import { applyManagedEnvironments } from "../services/managed-environments.js";
import {
  applyManagedPluginInstanceDefault,
  readManagedEnvironmentDefaultDecision,
} from "../services/managed-environment-default.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";

const PLUGIN_KEY = "paperclip-cloud.plugin-agent-computer";
const MARKER = `${PLUGIN_KEY}:tasks`;

function managedConfig(entry: Record<string, unknown> | null, sandbox = false) {
  const environmentEntries: unknown[] = [];
  if (sandbox) environmentEntries.push({ name: "Paperclip Sandbox", provider: "daytona" });
  if (entry) environmentEntries.push(entry);
  return parseManagedConfigEnv({
    [MANAGED_CONFIG_ENV_KEY]: JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.1106.0",
      features: {},
      plugins: { autoInstall: ["daytona", "agent-computer"] },
      environments: environmentEntries,
    }),
  });
}

const computer = (overrides: Record<string, unknown> = {}) => ({
  name: "Paperclip Computer",
  description: "Runs the agent on its own computer",
  driver: "plugin",
  pluginKey: PLUGIN_KEY,
  driverKey: "tasks",
  driverConfig: {},
  instanceDefault: true,
  ...overrides,
});

type ReadyListener = (payload: { pluginId: string }) => void;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("managed-config plugin environments", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let pluginId: string;
  let running: boolean;
  let readyListeners: ReadyListener[];
  const call = vi.fn(async (_id: string, method: string) =>
    method === "environmentValidateConfig" ? { ok: true, normalizedConfig: {} } : null);
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
    database = await startEmbeddedPostgresTestDatabase("paperclip-managed-plugin-environments-");
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
      packageName: "@paperclip-cloud/plugin-agent-computer",
      version: "1.0.0",
      status: "ready",
      manifestJson: {
        agentLifecycle: true,
        capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }],
      } as never,
    });
  });

  const boot = (config = managedConfig(computer())) =>
    applyManagedEnvironments(db, config, { env: {}, workerManager, autoInstalledPluginKeys: [PLUGIN_KEY] });
  const pluginRows = () => db.select().from(environments).where(eq(environments.driver, "plugin"));
  const instanceDefault = async () =>
    (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0]?.defaultEnvironmentId ?? null;
  const setInstanceDefault = async (environmentId: string | null) => {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    if (row) await db.update(instanceSettings).set({ defaultEnvironmentId: environmentId }).where(eq(instanceSettings.id, row.id));
    else await db.insert(instanceSettings).values({ singletonKey: "default", defaultEnvironmentId: environmentId });
  };
  const company = async () => {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Managed", issuePrefix: `M${id.slice(0, 7)}` });
    return id;
  };
  const agent = async (companyId: string, defaultEnvironmentId: string | null) => {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: `Agent ${id}`, adapterType: "process", defaultEnvironmentId });
    return id;
  };
  const recover = async () => {
    running = true;
    for (const listener of [...readyListeners]) listener({ pluginId });
    await vi.waitFor(async () => expect((await pluginRows())[0]?.status).toBe("active"));
    // The default decision runs after the row write in the same recovery task.
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it("creates the row on first boot, validates its config through the plugin, and changes nothing on the second", async () => {
    const first = await boot();
    const [row] = await pluginRows();
    expect(first).toMatchObject({ ensured: 1, added: 1, failed: 0 });
    expect(row).toMatchObject({
      name: "Paperclip Computer",
      description: "Runs the agent on its own computer",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
      metadata: { managedByPaperclip: true, managedPluginEnvironment: MARKER },
    });
    expect(call).toHaveBeenCalledWith(pluginId, "environmentValidateConfig", { driverKey: "tasks", config: {} });

    const second = await boot();
    const after = await pluginRows();
    expect(second).toMatchObject({ ensured: 1, added: 0, unchanged: 1 });
    expect(after).toHaveLength(1);
    expect(after[0]!.updatedAt.getTime()).toBe(row!.updatedAt.getTime());
  });

  it("adopts a hand-made row for the same plugin and driver, keeping its agents", async () => {
    const companyId = await company();
    const [handMade] = await db.insert(environments).values({
      name: "Computer (manual)",
      driver: "plugin",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
      metadata: { note: "made by hand" },
    }).returning();
    const agentId = await agent(companyId, handMade!.id);

    const result = await boot();
    const rows = await pluginRows();
    expect(result?.pluginOutcomes[0]?.action).toBe("adopted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: handMade!.id,
      name: "Paperclip Computer",
      metadata: { note: "made by hand", managedByPaperclip: true, managedPluginEnvironment: MARKER },
    });
    const [kept] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(kept!.defaultEnvironmentId).toBe(handMade!.id);
  });

  it("archives the row while the plugin is down and reactivates it when the worker recovers", async () => {
    await boot();
    running = false;
    const degraded = await boot();
    expect(degraded).toMatchObject({ ensured: 0, failed: 1 });
    expect((await pluginRows())[0]!.status).toBe("archived");

    await recover();
    expect((await pluginRows())[0]!.status).toBe("active");
  });

  it("never archives a row whose entry left the document", async () => {
    await boot();
    expect(await boot(managedConfig(null))).toBeNull();
    expect((await pluginRows())[0]!.status).toBe("active");
  });

  it("makes the row the default on an instance with no agents, replacing a stamped sandbox default", async () => {
    const [sandbox] = await db.insert(environments).values({
      name: "Paperclip Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
      metadata: { managedByPaperclip: true, managedSandboxProvider: "daytona", managedDefaultStamped: true },
    }).returning();
    // A stamped sandbox default only exists under managed-sandbox-only, where
    // the boot pass stamps it just before the plugin entry runs. Without that
    // feature the boot pass would revert the stamp first, so evaluate the
    // decision directly on the row an earlier boot created.
    await boot(managedConfig(computer({ instanceDefault: false })));
    const [row] = await pluginRows();
    await setInstanceDefault(sandbox!.id);
    await applyManagedPluginInstanceDefault(db, { environment: row!, marker: MARKER });
    expect(await instanceDefault()).toBe(row!.id);
    const [stampCleared] = await db.select().from(environments).where(eq(environments.id, sandbox!.id));
    expect(stampCleared!.metadata).not.toHaveProperty("managedDefaultStamped");
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({
      status: "applied",
      reason: "no_agents",
      environmentMarker: MARKER,
      environmentId: row!.id,
      previousDefaultEnvironmentId: sandbox!.id,
    });
  });

  it("never replaces a tenant-chosen default", async () => {
    const [chosen] = await db.insert(environments).values({
      name: "Tenant sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
      metadata: null,
    }).returning();
    await setInstanceDefault(chosen!.id);
    await boot();
    expect(await instanceDefault()).toBe(chosen!.id);
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "declined", reason: "tenant_default" });
  });

  it("leaves the default alone on an instance that already has agents", async () => {
    await agent(await company(), null);
    await boot();
    expect(await instanceDefault()).toBeNull();
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "declined", reason: "instance_has_agents" });
  });

  it("applies once: an admin's later change survives reboots and removing the flag changes nothing", async () => {
    await boot();
    const [row] = await pluginRows();
    expect(await instanceDefault()).toBe(row!.id);

    await setInstanceDefault(null);
    await boot();
    expect(await instanceDefault()).toBeNull();

    await boot(managedConfig(computer({ instanceDefault: false })));
    expect(await instanceDefault()).toBeNull();
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "applied" });
  });

  it("waits for a row that is not active yet, then leaves the default alone if an agent follows it by then", async () => {
    running = false;
    await boot();
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending", environmentId: null });

    await agent(await company(), null);
    await recover();
    expect(await instanceDefault()).toBeNull();
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "declined", reason: "agents_follow_default" });
  });

  it("waits for a row that is not active yet, then sets the default when no agent follows it", async () => {
    running = false;
    await boot();
    const [sandbox] = await db.insert(environments).values({
      name: "Explicit sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" },
    }).returning();
    await agent(await company(), sandbox!.id);

    await recover();
    const [row] = await pluginRows();
    expect(await instanceDefault()).toBe(row!.id);
    expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "applied", reason: "no_agents_follow_default" });
  });

  it("prepares a new agent that follows the default with the plugin, and one set to the sandbox without it", async () => {
    await boot();
    const [sandbox] = await db.insert(environments).values({
      name: "Paperclip Sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" },
    }).returning();
    const companyId = await company();
    const selection = async (id: string) =>
      createLifecycleDriver(db, { call } as never)
        .requiredPluginIds((await createLifecycleStore(db, createAgentLifecycleEffects()).get(id))!);

    expect(await selection(await agent(companyId, null))).toEqual([pluginId]);
    expect(await selection(await agent(companyId, sandbox!.id))).toEqual([]);
  });
});
