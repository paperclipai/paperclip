import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, environments, companies, instanceSettings, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createStatementCensus } from "./helpers/statement-census.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { INSTANCE_SETTINGS_CACHE_TTL_MS, invalidateInstanceSettingsCache } from "../services/instance-settings-cache.js";
import { fillUnsetInstanceDefault } from "../services/managed-instance-default.js";

const support = await getEmbeddedPostgresTestSupport();

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return Date.now() - started;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

(support.supported ? describe : describe.skip)("instance settings read-through cache", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let otherProcess: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("instance-settings-cache-");
    db = createDb(database.connectionString);
    otherProcess = createDb(database.connectionString);
    await db.insert(companies).values({ name: "Settings cache", issuePrefix: "SCC" });
  }, 90_000);

  afterAll(async () => {
    await Promise.all([db?.$client.end({ timeout: 0 }), otherProcess?.$client.end({ timeout: 0 })]);
    await database?.cleanup();
  }, 60_000);

  beforeEach(async () => {
    await db.delete(instanceSettings);
    invalidateInstanceSettingsCache();
  });

  it("serves repeated hot reads from one statement", async () => {
    const census = createStatementCensus(db);
    try {
      const settings = instanceSettingsService(db);
      await settings.get();
      const measured = await census.measure(async () => {
        for (let index = 0; index < 50; index++) {
          await Promise.all([settings.getGeneral(), settings.getExperimental(), instanceSettingsService(db).get()]);
        }
      });
      expect(measured.statements).toBe(0);
      invalidateInstanceSettingsCache();
      const concurrent = await census.measure(() => Promise.all(Array.from({ length: 20 }, () => settings.getExperimental())));
      expect(concurrent.statements).toBe(1);
    } finally {
      census.uninstall();
    }
  });

  it("reads its own writes in this process at once", async () => {
    const settings = instanceSettingsService(db);
    expect((await settings.getExperimental()).enableIsolatedWorkspaces).toBe(false);
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    expect((await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces).toBe(true);
    expect((await settings.getGeneral()).censorUsernameInLogs).toBe(false);
    await settings.updateGeneral({ censorUsernameInLogs: true });
    expect((await settings.getGeneral()).censorUsernameInLogs).toBe(true);
  });

  it("sees a default environment committed in a caller's transaction once it commits", async () => {
    const settings = instanceSettingsService(db);
    expect((await settings.get()).defaultEnvironmentId).toBeNull();
    const [environment] = await db.insert(environments).values({
      name: "Managed Sandbox", driver: "sandbox", status: "active", config: {},
    }).returning({ id: environments.id });
    expect((await fillUnsetInstanceDefault(db, environment!.id)).filled).toBe(true);
    expect((await settings.get()).defaultEnvironmentId).toBe(environment!.id);
  });

  it("takes a change made by another process within the cache bound", async () => {
    const settings = instanceSettingsService(db);
    expect((await settings.getExperimental()).enableIsolatedWorkspaces).toBe(false);
    const changedAt = Date.now();
    await otherProcess.update(instanceSettings)
      .set({ experimental: sql`coalesce(${instanceSettings.experimental}, '{}'::jsonb) || '{"enableIsolatedWorkspaces":true}'::jsonb` })
      .where(eq(instanceSettings.singletonKey, "default"));
    await waitUntil(async () => (await settings.getExperimental()).enableIsolatedWorkspaces === true,
      INSTANCE_SETTINGS_CACHE_TTL_MS + 1_000);
    expect(Date.now() - changedAt).toBeLessThanOrEqual(INSTANCE_SETTINGS_CACHE_TTL_MS + 500);
  });

  it("never shares cached rows with callers that mutate them", async () => {
    const settings = instanceSettingsService(db);
    const first = await settings.get();
    (first.experimental as Record<string, unknown>).enableIsolatedWorkspaces = true;
    expect((await settings.get()).experimental.enableIsolatedWorkspaces).toBe(false);
  });

  it("reads inside a transaction bypass the cache", async () => {
    const settings = instanceSettingsService(db);
    expect((await settings.getExperimental()).enableIsolatedWorkspaces).toBe(false);
    await db.transaction(async tx => {
      await tx.update(instanceSettings).set({ experimental: { enableIsolatedWorkspaces: true } })
        .where(eq(instanceSettings.singletonKey, "default"));
      expect((await instanceSettingsService(tx as unknown as Db).getExperimental()).enableIsolatedWorkspaces).toBe(true);
      throw new Error("rollback");
    }).catch(() => undefined);
    expect((await settings.getExperimental()).enableIsolatedWorkspaces).toBe(false);
  });
});
