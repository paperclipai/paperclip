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
import {
  applyManagedEnvironments,
  createManagedEnvironmentRecovery,
  registerManagedPluginInstanceDefaultRetry,
  retryManagedPluginInstanceDefault,
} from "../services/managed-environments.js";
import {
  applyManagedPluginInstanceDefault,
  cancelPendingManagedEnvironmentDefault,
  readManagedEnvironmentDefaultDecision,
} from "../services/managed-environment-default.js";
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
  // Manager-wide `ready` subscriptions (`onWorkerReady`), which the boot pass
  // and the default retry worker both prefer over the handle's.
  const managerReadyListeners = new Set<(pluginId: string) => void>();
  const workerManager = {
    isRunning: vi.fn(() => running),
    call,
    getWorker: vi.fn(() => ({
      on: (_event: "ready", listener: ReadyListener) => { readyListeners.push(listener); },
      off: (_event: "ready", listener: ReadyListener) => {
        readyListeners = readyListeners.filter((candidate) => candidate !== listener);
      },
    })),
    onWorkerReady: (listener: (pluginId: string) => void) => {
      managerReadyListeners.add(listener);
      return () => { managerReadyListeners.delete(listener); };
    },
  };
  /** The plugin's worker reports `ready` (first start, respawn or replacement). */
  const fireReady = () => {
    for (const listener of [...readyListeners]) listener({ pluginId });
    for (const listener of [...managerReadyListeners]) listener(pluginId);
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-managed-plugin-environment-rows-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    running = true;
    readyListeners = [];
    managerReadyListeners.clear();
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
      fireReady();
      await vi.waitFor(async () => expect((await pluginRows())[0]?.status).toBe("active"));
    });

    it("never archives a row whose entry left the document", async () => {
      await boot();
      expect(await boot([])).toBeNull();
      expect((await pluginRows())[0]!.status).toBe("active");
    });
  });

  /*
   * Coverage of the decision lifecycle (entry point x condition). The retry
   * worker is the only decider; the boot pass never decides.
   *
   * | Entry point                  | Conditions covered                                              |
   * | ---------------------------- | --------------------------------------------------------------- |
   * | worker startup attempt       | no agents, agents, tenant default, plugin down, config rejected |
   * | worker `ready`               | follower appeared, no follower, admin chose meanwhile, rejected |
   * | coordinator retry            | every attempt timed out with the worker up                      |
   * | direct decision              | stamped sandbox default, concurrent agent insert (both ways)    |
   * | retry function               | stale active row, rejected config, already decided              |
   * | later boots                  | admin change survives, removing the flag changes nothing        |
   */
  describe("instanceDefault (one-time decision)", () => {
    const defaultEntry = { ...remoteHostEntry, instanceDefault: true };
    let workerAttempts: Promise<unknown>[] = [];
    /**
     * Start the retry worker the way `index.ts` does after the boot pass, on a
     * coordinator stand-in that runs pending attempts when woken. A throwing
     * attempt stops the drain (the real coordinator retries it 60 s later).
     */
    const startDefaultWorker = async (config: ReturnType<typeof managedConfig>) => {
      let task: { run: () => Promise<unknown>; hasPending: () => Promise<boolean> } | null = null;
      const drain = async () => {
        if (!task) return;
        try {
          while (await task.hasPending()) await task.run();
        } catch {
          // Left pending for the coordinator's retry.
        }
      };
      registerManagedPluginInstanceDefaultRetry({
        db,
        managedConfig: config,
        deliveryWork: {
          register: (_queue: string, registered: NonNullable<typeof task>) => {
            task = registered;
            return { wake: () => { workerAttempts.push(drain()); } };
          },
        } as never,
        workerManager,
        recovery: createManagedEnvironmentRecovery(),
      });
      await drain();
      return { drain: () => drain() };
    };
    /** One server start: the boot pass, then the default retry worker. */
    const boot = async (entries: unknown[] = [defaultEntry]) => {
      // A new process: the previous one's subscriptions are gone.
      managerReadyListeners.clear();
      readyListeners = [];
      const config = managedConfig(entries);
      const result = await applyManagedEnvironments(db, config, { env: {}, workerManager, autoInstalledPluginKeys: [PLUGIN_KEY] });
      lastWorker = await startDefaultWorker(config);
      return result;
    };
    let lastWorker: { drain: () => Promise<void> } = { drain: async () => {} };
    const settleWorker = async () => {
      while (workerAttempts.length > 0) await Promise.all(workerAttempts.splice(0));
    };
    const instanceDefault = async () =>
      (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0]?.defaultEnvironmentId ?? null;
    const setInstanceDefault = async (environmentId: string | null) => {
      const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
      if (row) await db.update(instanceSettings).set({ defaultEnvironmentId: environmentId }).where(eq(instanceSettings.id, row.id));
      else await db.insert(instanceSettings).values({ singletonKey: "default", defaultEnvironmentId: environmentId });
    };
    const agent = async (companyId: string, defaultEnvironmentId: string | null) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name: `Agent ${id}`, adapterType: "process", defaultEnvironmentId });
      return id;
    };
    /** The plugin comes back: the row recovers and the worker gets its attempt. */
    const recover = async () => {
      running = true;
      fireReady();
      await vi.waitFor(async () => expect((await pluginRows())[0]?.status).toBe("active"));
      await settleWorker();
    };

    it("sets the default on an instance with no agents", async () => {
      await boot();
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({
        status: "applied",
        reason: "no_agents",
        environmentMarker: MARKER,
        environmentId: row!.id,
        previousDefaultEnvironmentId: null,
      });
    });

    it("replaces a default the managed sandbox stamped, and clears the stamp", async () => {
      const [sandbox] = await db.insert(environments).values({
        name: "Managed Sandbox",
        driver: "sandbox",
        status: "active",
        config: { provider: "daytona" },
        metadata: { managedByPaperclip: true, managedSandboxProvider: "daytona", managedDefaultStamped: true },
      }).returning();
      // A stamped sandbox default only exists under managed-sandbox-only, where
      // the boot pass stamps it just before plugin entries run. Without that
      // feature the boot pass reverts the stamp first, so evaluate the decision
      // directly on the row an earlier boot created.
      await boot([remoteHostEntry]);
      const [row] = await pluginRows();
      await setInstanceDefault(sandbox!.id);
      await applyManagedPluginInstanceDefault(db, { environment: row!, marker: MARKER });
      expect(await instanceDefault()).toBe(row!.id);
      const [cleared] = await db.select().from(environments).where(eq(environments.id, sandbox!.id));
      expect(cleared!.metadata).not.toHaveProperty("managedDefaultStamped");
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({
        status: "applied",
        previousDefaultEnvironmentId: sandbox!.id,
      });
    });

    it("never replaces a tenant-chosen default", async () => {
      const [chosen] = await db.insert(environments).values({
        name: "Tenant sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" }, metadata: null,
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

    it("applies once: an admin's later change survives reboots, and removing the flag changes nothing", async () => {
      await boot();
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);

      await setInstanceDefault(null);
      await boot();
      expect(await instanceDefault()).toBeNull();

      await boot([remoteHostEntry]);
      expect(await instanceDefault()).toBeNull();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "applied" });
    });

    it("waits for the row, then keeps the default if an agent follows it by then", async () => {
      running = false;
      await boot();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending", environmentId: null });

      await agent(await company(), null);
      await recover();
      expect(await instanceDefault()).toBeNull();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "declined", reason: "agents_follow_default" });
    });

    it("waits for the row, then sets the default when no agent follows it", async () => {
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

    it("never replaces an admin's explicit choice made while the decision is pending", async () => {
      running = false;
      await boot();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending" });

      // The admin explicitly clears the default (the route writes it, then
      // cancels the pending decision, in one transaction).
      await db.transaction(async (tx) => {
        await setInstanceDefault(null);
        expect(await cancelPendingManagedEnvironmentDefault(tx as unknown as Db, { instanceDefaultDeclared: true })).toBe(true);
      });
      await recover();

      expect(await instanceDefault()).toBeNull();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "declined", reason: "admin_changed_default" });
    });

    it("waits for an in-flight agent insert, then sees that agent (controlled overlap)", async () => {
      running = false;
      await boot();
      running = true;
      // Make the row active without going through recovery, so only the
      // decision runs below.
      const row = (await environmentService(db).ensureManagedPluginEnvironment({
        name: "Remote Host", description: "Runs the agent on a remote host",
        pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {}, workerManager,
      })).environment;
      const companyId = await company();

      let releaseInsert!: () => void;
      const insertHeld = new Promise<void>((resolve) => { releaseInsert = resolve; });
      let inserted!: () => void;
      const insertDone = new Promise<void>((resolve) => { inserted = resolve; });
      const agentWrite = db.transaction(async (tx) => {
        await tx.insert(agents).values({ id: randomUUID(), companyId, name: "Racing agent", adapterType: "process", defaultEnvironmentId: null });
        inserted();
        await insertHeld;
      });
      await insertDone;

      let settled = false;
      const decision = applyManagedPluginInstanceDefault(db, { environment: row, marker: MARKER })
        .then((outcome) => { settled = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The decision waits on the SHARE lock behind the uncommitted insert.
      expect(settled).toBe(false);

      releaseInsert();
      await agentWrite;
      expect(await decision).toMatchObject({ status: "declined", reason: "agents_follow_default" });
      expect(await instanceDefault()).toBeNull();
    });

    it("holds new agent writes until the decision commits", async () => {
      running = false;
      await boot();
      running = true;
      const row = (await environmentService(db).ensureManagedPluginEnvironment({
        name: "Remote Host", description: "Runs the agent on a remote host",
        pluginKey: PLUGIN_KEY, driverKey: "tasks", driverConfig: {}, workerManager,
      })).environment;
      const companyId = await company();

      // Hold the decision's locks open by holding the instance default row
      // in another transaction until the agent insert has been attempted.
      let releaseDefault!: () => void;
      const defaultHeld = new Promise<void>((resolve) => { releaseDefault = resolve; });
      let defaultLocked!: () => void;
      const defaultLockTaken = new Promise<void>((resolve) => { defaultLocked = resolve; });
      const blocker = db.transaction(async (tx) => {
        await tx.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).for("update");
        defaultLocked();
        await defaultHeld;
      });
      await defaultLockTaken;
      // The decision takes SHARE on agents, then waits for the default row.
      const decision = applyManagedPluginInstanceDefault(db, { environment: row, marker: MARKER });
      await new Promise((resolve) => setTimeout(resolve, 200));

      let agentInserted = false;
      const agentWrite = db.insert(agents)
        .values({ id: randomUUID(), companyId, name: "Late agent", adapterType: "process", defaultEnvironmentId: null })
        .then(() => { agentInserted = true; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(agentInserted).toBe(false);

      releaseDefault();
      await blocker;
      expect(await decision).toMatchObject({ status: "applied" });
      await agentWrite;
      expect(agentInserted).toBe(true);
      // The agent inserted after the commit follows the new default.
      expect(await instanceDefault()).toBe(row.id);
    });

    it("lets the retry worker finish a decision after ensuring the current entry", async () => {
      const config = managedConfig([defaultEntry]);
      await boot([remoteHostEntry]);
      call.mockClear();
      expect(await retryManagedPluginInstanceDefault(db, config, workerManager)).toBe("evaluated");
      // The current declaration was validated again before the default applied.
      expect(call).toHaveBeenCalledWith(pluginId, "environmentValidateConfig", { driverKey: "tasks", config: {} });
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);
      expect(await retryManagedPluginInstanceDefault(db, config, workerManager)).toBe("nothing_to_do");
      expect(await retryManagedPluginInstanceDefault(db, managedConfig([remoteHostEntry]), workerManager)).toBe("nothing_to_do");
    });

    it("keeps retrying when every attempt times out while the worker keeps running", async () => {
      await boot([remoteHostEntry]);
      // The boot ensure, its immediate recovery attempt, and the worker's
      // startup attempt all time out; the worker stays up throughout.
      call.mockRejectedValueOnce(new Error("environmentValidateConfig timed out"));
      call.mockRejectedValueOnce(new Error("environmentValidateConfig timed out"));
      call.mockRejectedValueOnce(new Error("environmentValidateConfig timed out"));
      await boot();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await instanceDefault()).toBeNull();
      // The row from the earlier boot was kept, not archived, and the failed
      // startup attempt still recorded the first evaluation.
      expect((await pluginRows())[0]!.status).toBe("active");
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending" });

      // An agent explicitly set to another environment appears before the
      // retry: it does not follow the default, so the default still applies.
      const [sandbox] = await db.insert(environments).values({
        name: "Explicit sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" },
      }).returning();
      await agent(await company(), sandbox!.id);

      // The coordinator's retry of the failed attempt applies the default.
      await lastWorker.drain();
      const [row] = await pluginRows();
      expect(await instanceDefault()).toBe(row!.id);
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "applied" });
    });

    it("waits while the plugin rejects the declared config, across a worker restart", async () => {
      // Every validation of the declared config is refused.
      call.mockImplementation(async (_id: string, method: string) =>
        (method === "environmentValidateConfig" ? { ok: false, errors: ["region is not supported"] } : null) as never);
      try {
        await boot([{ ...defaultEntry, driverConfig: { region: "nowhere" } }]);
        expect(await pluginRows()).toHaveLength(0);
        expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending", environmentId: null });

        fireReady();
        await settleWorker();
        expect(await instanceDefault()).toBeNull();
        expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending" });
      } finally {
        call.mockImplementation(async (_id: string, method: string, input: { config: Record<string, unknown> }) =>
          (method === "environmentValidateConfig" ? { ok: true, normalizedConfig: { ...input.config, normalized: true } } : null) as never);
      }
    });

    it("never applies the default from a stale active row whose plugin is down", async () => {
      const config = managedConfig([defaultEntry]);
      await boot([remoteHostEntry]);
      expect((await pluginRows())[0]!.status).toBe("active");
      running = false;
      expect(await retryManagedPluginInstanceDefault(db, config, workerManager)).toBe("waiting_for_plugin");
      expect(await instanceDefault()).toBeNull();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending" });
    });

    it("never applies the default from an older row when the plugin rejects the declared config", async () => {
      const config = managedConfig([{ ...defaultEntry, driverConfig: { region: "nowhere" } }]);
      await boot([remoteHostEntry]);
      expect((await pluginRows())[0]!.status).toBe("active");
      call.mockImplementationOnce(async () => ({ ok: false, errors: ["region is not supported"] }) as never);
      expect(await retryManagedPluginInstanceDefault(db, config, workerManager)).toBe("config_rejected");
      expect(await instanceDefault()).toBeNull();
      expect(await readManagedEnvironmentDefaultDecision(db)).toMatchObject({ status: "pending" });
    });

    it("prepares a new agent that follows the default with the plugin, and one set to the sandbox without it", async () => {
      await boot();
      const [sandbox] = await db.insert(environments).values({
        name: "Managed Sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" },
      }).returning();
      const companyId = await company();
      const selection = async (id: string) =>
        createLifecycleDriver(db, { call } as never)
          .requiredPluginIds((await createLifecycleStore(db, createAgentLifecycleEffects()).get(id))!);

      expect(await selection(await agent(companyId, null))).toEqual([pluginId]);
      expect(await selection(await agent(companyId, sandbox!.id))).toEqual([]);
    });
  });
});
