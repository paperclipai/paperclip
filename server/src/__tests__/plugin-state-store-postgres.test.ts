import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { applyPendingMigrations, companies, createDb, plugins, pluginState, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_STATE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("plugin state JSON values with PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  let store: ReturnType<typeof pluginStateStore>;
  const pluginIds = [randomUUID(), randomUUID()];
  const companyIds = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("plugin-state-json-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 4 });
    store = pluginStateStore(db);
    for (const id of pluginIds) {
      const manifest = { id: `state-${id}`, apiVersion: 1 as const, version: "1.0.0", displayName: "State fixture",
        description: "State persistence fixture", author: "Test", categories: [], capabilities: [], entrypoints: { worker: "worker.cjs" } };
      await db.insert(plugins).values({ id, pluginKey: manifest.id, packageName: "state-fixture", version: manifest.version, manifestJson: manifest });
    }
    for (const id of companyIds) await db.insert(companies).values({ id, name: "State company", issuePrefix: `S${id.slice(0, 6)}` });
  }, 60_000);

  afterAll(async () => {
    try {
      if (db) {
        await db.delete(plugins).where(inArray(plugins.id, pluginIds));
        await db.delete(companies).where(inArray(companies.id, companyIds));
      }
    } finally {
      await db?.$client.end({ timeout: 1 });
      await temporary?.cleanup();
    }
  });

  it.each(["instance", "company"] as const)("inserts JSON null and preserves it through get/list for %s scope", async scopeKind => {
    const stateKey = `insert-null-${scopeKind}`;
    const scopeId = scopeKind === "company" ? companyIds[0]! : undefined;
    await store.set(pluginIds[0]!, { scopeKind, scopeId, stateKey, value: null });
    expect(await store.get(pluginIds[0]!, scopeKind, stateKey, { scopeId })).toBeNull();
    const rows = (await store.list(pluginIds[0]!, { scopeKind, scopeId })).filter(row => row.stateKey === stateKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valueJson).toBeNull();
    const [stored] = await db.select({ sqlNull: sql<boolean>`${pluginState.valueJson} IS NULL`, jsonType: sql<string>`jsonb_typeof(${pluginState.valueJson})` })
      .from(pluginState).where(eq(pluginState.id, rows[0]!.id));
    expect(stored).toEqual({ sqlNull: false, jsonType: "null" });
  });

  it.each(["instance", "company"] as const)("updates value to null and back without duplicating %s state", async scopeKind => {
    const stateKey = `replace-${scopeKind}`;
    const scopeId = scopeKind === "company" ? companyIds[0]! : undefined;
    const input = { scopeKind, scopeId, stateKey };
    await store.set(pluginIds[0]!, { ...input, value: { count: 1 } });
    const original = (await store.list(pluginIds[0]!, { scopeKind, scopeId })).find(row => row.stateKey === stateKey)!;
    for (const value of [null, { nested: [null, false, 0, "text"] }, "text", 42, false, [1, null]]) {
      await store.set(pluginIds[0]!, { ...input, value });
      expect(await store.get(pluginIds[0]!, scopeKind, stateKey, { scopeId })).toEqual(value);
      const rows = (await store.list(pluginIds[0]!, { scopeKind, scopeId })).filter(row => row.stateKey === stateKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: original.id, valueJson: value });
    }
  });

  it("keeps null values isolated by company, plugin, and namespace", async () => {
    const stateKey = "scoped-null";
    await store.set(pluginIds[0]!, { scopeKind: "company", scopeId: companyIds[0]!, stateKey, value: null });
    await store.set(pluginIds[0]!, { scopeKind: "company", scopeId: companyIds[1]!, stateKey, value: { company: 2 } });
    await store.set(pluginIds[1]!, { scopeKind: "company", scopeId: companyIds[0]!, stateKey, value: { plugin: 2 } });
    await store.set(pluginIds[0]!, { scopeKind: "company", scopeId: companyIds[0]!, namespace: "other", stateKey, value: "namespaced" });
    for (const [pluginId, scopeId, namespace, value] of [
      [pluginIds[0]!, companyIds[0]!, "default", null],
      [pluginIds[0]!, companyIds[1]!, "default", { company: 2 }],
      [pluginIds[1]!, companyIds[0]!, "default", { plugin: 2 }],
      [pluginIds[0]!, companyIds[0]!, "other", "namespaced"],
    ] as const) {
      expect(await store.get(pluginId, "company", stateKey, { scopeId, namespace })).toEqual(value);
      const rows = (await store.list(pluginId, { scopeKind: "company", scopeId, namespace })).filter(row => row.stateKey === stateKey);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.valueJson).toEqual(value);
    }
    expect(await store.get(pluginIds[1]!, "company", stateKey, { scopeId: companyIds[1]! })).toBeNull();
    expect(await store.list(pluginIds[1]!, { scopeKind: "company", scopeId: companyIds[1]! })).toEqual([]);
  });

  it("rejects undefined without inserting a row or changing an existing value", async () => {
    const input = { scopeKind: "instance" as const, stateKey: "undefined" };
    await expect(store.set(pluginIds[0]!, { ...input, value: undefined })).rejects.toMatchObject({ status: 400 });
    expect(await db.select().from(pluginState).where(and(eq(pluginState.pluginId, pluginIds[0]!), eq(pluginState.stateKey, input.stateKey)))).toEqual([]);
    await store.set(pluginIds[0]!, { ...input, value: { preserved: true } });
    await expect(store.set(pluginIds[0]!, { ...input, value: undefined })).rejects.toMatchObject({ status: 400 });
    expect(await store.get(pluginIds[0]!, "instance", input.stateKey)).toEqual({ preserved: true });
  });
});
