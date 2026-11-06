import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environments,
  plugins,
  type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentService } from "../services/environments.js";

const PLUGIN_KEY = "paperclip-cloud.plugin-agent-computer";
const MARKER = `${PLUGIN_KEY}:tasks`;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("managed plugin environment rows", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let pluginId: string;
  let running: boolean;
  const call = vi.fn(async (_id: string, method: string, input: { config: Record<string, unknown> }) =>
    method === "environmentValidateConfig" ? { ok: true, normalizedConfig: { ...input.config, normalized: true } } : null);
  const workerManager = { isRunning: vi.fn(() => running), call };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-managed-plugin-environment-rows-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    running = true;
    call.mockClear();
    await db.delete(activityLog);
    await db.delete(agents);
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
        capabilities: ["environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }],
      } as never,
    });
  });

  const ensure = (overrides: Record<string, unknown> = {}) =>
    environmentService(db).ensureManagedPluginEnvironment({
      name: "Paperclip Computer",
      description: "Runs the agent on its own computer",
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
      name: "Paperclip Computer",
      description: "Runs the agent on its own computer",
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
      name: "Computer (manual)",
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
      name: "Paperclip Computer",
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
    await db.insert(environments).values({ name: "Paperclip Computer", driver: "ssh", status: "active", config: {} });
    await expect(ensure()).rejects.toThrow(/already exists with driver "ssh"/);
  });

  it("allows at most one row per marker", async () => {
    await ensure();
    await expect(db.insert(environments).values({
      name: "Second computer",
      driver: "plugin",
      status: "active",
      config: { pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {} },
      metadata: { managedPluginEnvironment: MARKER },
    })).rejects.toThrow();
  });
});
