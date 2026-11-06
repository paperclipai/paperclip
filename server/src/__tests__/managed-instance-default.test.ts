import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, environments, instanceSettings, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { fillUnsetInstanceDefault } from "../services/managed-instance-default.js";
import { applyManagedEnvironments } from "../services/managed-environments.js";
import { MANAGED_CONFIG_ENV_KEY, parseManagedConfigEnv } from "../services/managed-config.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("managed instance default (locked fill)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let sandboxId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-managed-instance-default-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await db.delete(instanceSettings);
    await db.delete(environments);
    const [sandbox] = await db.insert(environments).values({
      name: "Managed Sandbox",
      driver: "sandbox",
      status: "active",
      config: { provider: "daytona" },
      metadata: { managedByPaperclip: true, managedSandboxProvider: "daytona" },
    }).returning();
    sandboxId = sandbox!.id;
  });

  const instanceDefault = async () =>
    (await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")))[0]?.defaultEnvironmentId ?? null;
  const setInstanceDefault = async (environmentId: string | null) => {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    if (row) await db.update(instanceSettings).set({ defaultEnvironmentId: environmentId }).where(eq(instanceSettings.id, row.id));
    else await db.insert(instanceSettings).values({ singletonKey: "default", defaultEnvironmentId: environmentId });
  };
  const environment = async (name: string, driver: string) => {
    const [row] = await db.insert(environments).values({ name, driver, status: "active", config: {} }).returning();
    return row!.id;
  };

  it("fills an unset default, including on a fresh instance with no settings row", async () => {
    expect(await fillUnsetInstanceDefault(db, sandboxId)).toEqual({ filled: true, previousDefaultEnvironmentId: null });
    expect(await instanceDefault()).toBe(sandboxId);
  });

  it("fills a default that names the local environment", async () => {
    const localId = await environment("Local", "local");
    await setInstanceDefault(localId);
    expect(await fillUnsetInstanceDefault(db, sandboxId)).toEqual({ filled: true, previousDefaultEnvironmentId: localId });
    expect(await instanceDefault()).toBe(sandboxId);
  });

  it("fills a default whose environment was deleted (the reference is cleared)", async () => {
    const goneId = await environment("Gone", "ssh");
    await setInstanceDefault(goneId);
    await db.delete(environments).where(eq(environments.id, goneId));
    expect(await fillUnsetInstanceDefault(db, sandboxId)).toMatchObject({ filled: true });
    expect(await instanceDefault()).toBe(sandboxId);
  });

  it("never changes a set default, whatever chose it", async () => {
    for (const driver of ["ssh", "plugin", "sandbox"]) {
      const chosenId = await environment(`Chosen ${driver}`, driver);
      await setInstanceDefault(chosenId);
      expect(await fillUnsetInstanceDefault(db, sandboxId)).toEqual({ filled: false, previousDefaultEnvironmentId: chosenId });
      expect(await instanceDefault()).toBe(chosenId);
    }
  });

  it("leaves a default that already names the target alone", async () => {
    await setInstanceDefault(sandboxId);
    expect(await fillUnsetInstanceDefault(db, sandboxId)).toEqual({ filled: false, previousDefaultEnvironmentId: sandboxId });
  });

  it("waits for an overlapping default write and then keeps it (controlled overlap)", async () => {
    const chosenId = await environment("Admin choice", "ssh");
    await setInstanceDefault(null);
    // An admin's default write holds the row while the fill starts.
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => { locked = resolve; });
    const adminWrite = db.transaction(async (tx) => {
      await tx.update(instanceSettings).set({ defaultEnvironmentId: chosenId }).where(eq(instanceSettings.singletonKey, "default"));
      locked();
      await writeHeld;
    });
    await rowLocked;

    let settled = false;
    const fill = fillUnsetInstanceDefault(db, sandboxId).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // An unlocked read-then-write would already have filled the stale "unset".
    expect(settled).toBe(false);

    releaseWrite();
    await adminWrite;
    expect(await fill).toEqual({ filled: false, previousDefaultEnvironmentId: chosenId });
    expect(await instanceDefault()).toBe(chosenId);
  });

  it("lets only one of two overlapping boots fill", async () => {
    const results = await Promise.all([fillUnsetInstanceDefault(db, sandboxId), fillUnsetInstanceDefault(db, sandboxId)]);
    expect(results.filter((result) => result.filled)).toHaveLength(1);
    expect(await instanceDefault()).toBe(sandboxId);
  });

  describe("boot (applyManagedEnvironments)", () => {
    const managedConfig = (features: Record<string, unknown>) => parseManagedConfigEnv({
      [MANAGED_CONFIG_ENV_KEY]: JSON.stringify({
        v: 1,
        mode: "cloud",
        catalogVersion: "2026.1106.0",
        features,
        plugins: { autoInstall: ["daytona"] },
        environments: [{ name: "Managed Sandbox", provider: "daytona" }],
      }),
    });
    const boot = async (features: Record<string, unknown>) => {
      const [row] = await db.select().from(environments).where(eq(environments.id, sandboxId));
      return applyManagedEnvironments(db, managedConfig(features), {
        env: {},
        workerManager: { isRunning: () => true, getWorker: () => undefined },
        environments: {
          ensureManagedSandboxEnvironment: vi.fn(async () => ({
            environment: row as never,
            action: "unchanged" as const,
            stockStatus: "stock_current" as const,
            updateAvailable: false,
            stockHash: "sha256:stock",
          })),
          archiveManagedSandboxEnvironment: vi.fn(async () => null),
          ensureManagedPluginEnvironment: vi.fn(),
          archiveManagedPluginEnvironment: vi.fn(async () => null),
        },
        resolveSandboxProviderDriver: async () => ({ plugin: { id: "daytona-plugin", pluginKey: "daytona", status: "ready" } }),
      });
    };

    it("fills the default under managed-sandbox-only, and never reverts it when the mode is off", async () => {
      await boot({ enableManagedSandboxOnly: true });
      expect(await instanceDefault()).toBe(sandboxId);

      await boot({});
      expect(await instanceDefault()).toBe(sandboxId);
    });

    it("keeps a set default on every boot", async () => {
      const chosenId = await environment("Admin choice", "ssh");
      await setInstanceDefault(chosenId);
      await boot({ enableManagedSandboxOnly: true });
      await boot({ enableManagedSandboxOnly: true });
      expect(await instanceDefault()).toBe(chosenId);
    });
  });
});
