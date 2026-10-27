import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginEnvironmentDriverDeclaration } from "@paperclipai/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { resolvePluginSandboxProviderDriverByKey } from "../services/plugin-environment-driver.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("sandbox-provider plugin selection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const key = "fixture-provider";
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const driver = (driverKey: string, kind: PluginEnvironmentDriverDeclaration["kind"] = "sandbox_provider") => ({
    driverKey, kind, displayName: driverKey, configSchema: { type: "object" },
  });
  const manifest = (id: string, environmentDrivers: PluginEnvironmentDriverDeclaration[]): PaperclipPluginManifestV1 => ({
    id: `test.selection.${id}`, apiVersion: 1, version: "1.0.0", displayName: "Selection fixture",
    description: "Fixture", author: "Test", categories: ["automation"],
    capabilities: ["environment.drivers.register"], entrypoints: { worker: "worker.js" }, environmentDrivers,
  });
  const largeDriver = { ...driver("other-provider"), configSchema: { type: "object", description: randomBytes(64 * 1024).toString("hex") } };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-provider-selection-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  beforeEach(async () => {
    await db.delete(plugins);
    await db.insert(plugins).values(ids.map((id, index) => ({
      id, pluginKey: `test.selection.${id}`, packageName: "@test/selection", version: "1.0.0",
      installOrder: index, status: index === 1 ? "disabled" as const : "ready" as const,
      manifestJson: manifest(id, index === 0 ? [driver(key, "environment_driver"), largeDriver]
        : index < 4 ? [driver(key)] : index === 4 ? [largeDriver] : []),
    })));
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("keeps the unfiltered catalog and filters matching declarations in install order", async () => {
    const registry = pluginRegistryService(db);
    expect((await registry.list()).map(plugin => plugin.id)).toEqual(ids);
    const selected = await registry.list({ sandboxProviderDriverKey: key });
    expect(selected.map(plugin => plugin.id)).toEqual(ids.slice(1, 4));
    expect(selected[0].status).toBe("disabled");
    expect(selected.every(plugin => plugin.manifestJson.environmentDrivers?.some(
      entry => entry.driverKey === key && entry.kind === "sandbox_provider",
    ))).toBe(true);
    expect(await registry.list({ sandboxProviderDriverKey: "unknown-provider" })).toEqual([]);
  });

  it("filters the actual resolver query before large unrelated manifests cross the DB boundary", async () => {
    const statements: string[] = [];
    const recorded = drizzle(db.$client, {
      schema: db._.fullSchema,
      logger: { logQuery: query => statements.push(query) },
    }) as typeof db;
    const selected = await resolvePluginSandboxProviderDriverByKey({ db: recorded, driverKey: key });
    expect(selected?.plugin.id).toBe(ids[1]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('where "plugins"."manifest_json" @>');
    expect(statements[0]).toContain('order by "plugins"."install_order" asc');
  });

  it("keeps readiness and worker selection after the database filter", async () => {
    const isRunning = vi.fn((id: string) => id === ids[3]);
    const workerManager = { isRunning } as unknown as PluginWorkerManager;
    const selected = await resolvePluginSandboxProviderDriverByKey({ db, driverKey: key, workerManager, requireRunning: true });
    expect(selected?.plugin.id).toBe(ids[3]);
    expect(isRunning.mock.calls.map(([id]) => id)).toEqual([ids[2], ids[3]]);
    expect(await resolvePluginSandboxProviderDriverByKey({ db, driverKey: key, requireRunning: true })).toBeNull();
  });

  it("reads changed status and declarations on the next lookup", async () => {
    const workerManager = { isRunning: () => true } as unknown as PluginWorkerManager;
    const resolve = () => resolvePluginSandboxProviderDriverByKey({ db, driverKey: key, workerManager, requireRunning: true });
    expect((await resolve())?.plugin.id).toBe(ids[2]);
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, ids[2]));
    expect((await resolve())?.plugin.id).toBe(ids[3]);
    await db.update(plugins).set({ manifestJson: manifest(ids[3], [driver("replacement-provider")]) }).where(eq(plugins.id, ids[3]));
    expect(await resolve()).toBeNull();
  });

  it("binds unusual driver keys as JSON values", async () => {
    const unusual = "provider-\"quoted' OR true --";
    await db.update(plugins).set({ manifestJson: manifest(ids[4], [driver(unusual)]) }).where(eq(plugins.id, ids[4]));
    expect((await pluginRegistryService(db).list({ sandboxProviderDriverKey: unusual })).map(plugin => plugin.id)).toEqual([ids[4]]);
    expect((await resolvePluginSandboxProviderDriverByKey({ db, driverKey: unusual }))?.plugin.id).toBe(ids[4]);
  });
});
