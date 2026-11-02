import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, plugins, type Db } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import type { PaperclipPluginManifestV1, PluginEnvironmentDriverDeclaration } from "@paperclipai/shared";
import { resolvePluginSandboxProviderConfigSchema, resolvePluginSandboxProviderDriverByKey } from "../services/plugin-environment-driver.js";
import { resolveEnvironmentDriverConfigForRuntime, resolveSandboxProviderSecretRefPaths } from "../services/environment-config.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("sandbox provider schema reads", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const clients: Db[] = [];
  const key = "fixture-schema-provider";
  const driver = (driverKey = key, configSchema: unknown = { type: "object" }) => ({
    driverKey, kind: "sandbox_provider", displayName: "Schema fixture", configSchema,
  }) as PluginEnvironmentDriverDeclaration;
  const manifest = (id: string, declarations: PluginEnvironmentDriverDeclaration[]): PaperclipPluginManifestV1 => ({
    id: `test.schema.${id}`, apiVersion: 1, version: "1.0.0", displayName: "Schema fixture",
    description: "Fixture", author: "Test", categories: ["automation"],
    capabilities: ["environment.drivers.register"], entrypoints: { worker: "worker.js" }, environmentDrivers: declarations,
  });
  async function seed(declarations = [driver()], installOrder = 0) {
    const id = randomUUID();
    await db.insert(plugins).values({
      id, pluginKey: `test.schema.${id}`, packageName: "@test/schema", version: "1.0.0",
      installOrder, status: "disabled", manifestJson: manifest(id, declarations),
    });
    return id;
  }
  function observer() {
    const observed = createDb(temporary.connectionString);
    clients.push(observed);
    return observed;
  }
  const lookup = (client: Db, driverKey = key) => resolvePluginSandboxProviderConfigSchema({ db: client, driverKey });
  async function measure<T>(client: Db, operation: () => Promise<T>) {
    const events: Array<Record<string, unknown>> = [], now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event), () => now);
    installDatabaseResponseCapture(client, { plugins }, capture);
    try {
      const value = await operation();
      capture.flush();
      const entries = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1");
      return { value, bytes: entries.reduce((sum, entry) => sum + Number(entry.responseValueBytes), 0),
        calls: entries.reduce((sum, entry) => sum + Number(entry.calls), 0) };
    } finally { capture.flush(); }
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("sandbox-schema-reads-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  beforeEach(async () => { await db.delete(plugins); });
  afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.$client.end())); });
  afterAll(async () => { await temporary?.cleanup(); });

  it("keeps runtime secret paths current without retransferring an unchanged schema", async () => {
    const schema = { type: "object", description: randomBytes(16 * 1024).toString("hex"), properties: {
      credentials: { type: "object", properties: { token: { type: "string", format: "secret-ref" } } },
    } };
    const id = await seed([driver(key, schema)]), observed = observer();
    const before = await db.select().from(plugins).where(eq(plugins.id, id));
    const cold = await measure(observed, () => resolveSandboxProviderSecretRefPaths(observed, key));
    const warm = await measure(observed, () => resolveSandboxProviderSecretRefPaths(observed, key));
    expect(cold.value).toEqual(new Set(["credentials.token"]));
    expect(warm.value).toEqual(cold.value);
    expect(cold.calls).toBe(1);
    expect(warm.calls).toBe(1);
    expect(cold.bytes).toBeGreaterThan(32 * 1024);
    expect(warm.bytes).toBeLessThan(256);
    const changed = { type: "object", allOf: [{ properties: { apiKey: { type: "string", format: "secret-ref" } } }] };
    await db.update(plugins).set({ manifestJson: manifest(id, [driver(key, changed)]) }).where(eq(plugins.id, id));
    expect(await resolveSandboxProviderSecretRefPaths(observed, key)).toEqual(new Set(["apiKey"]));
    const environment = { id: randomUUID(), driver: "sandbox" as const, config: { provider: key, apiKey: randomUUID() } };
    await expect(resolveEnvironmentDriverConfigForRuntime(observed, null, environment)).rejects.toThrow("companyId");
    await db.update(plugins).set({ manifestJson: before[0].manifestJson }).where(eq(plugins.id, id));
    expect(await db.select().from(plugins).where(eq(plugins.id, id))).toEqual(before);
  });

  it("preserves install order, first matching declarations, and default readiness checks", async () => {
    const a = await seed([driver(key, { title: "first" }), driver(key, { title: "second" })], 1);
    const b = await seed([driver(key, { title: "other plugin" })], 2), observed = observer();
    expect((await lookup(observed))).toEqual({ title: "first" });
    const full = await resolvePluginSandboxProviderDriverByKey({ db: observed, driverKey: key });
    expect(full?.plugin.id).toBe(a);
    expect(full?.plugin.status).toBe("disabled");
    expect(await resolvePluginSandboxProviderDriverByKey({ db: observed, driverKey: key, requireRunning: true })).toBeNull();
    await db.update(plugins).set({ installOrder: 0 }).where(eq(plugins.id, b));
    expect((await lookup(observed))).toEqual({ title: "other plugin" });
    await db.delete(plugins).where(eq(plugins.id, b));
    expect((await lookup(observed))).toEqual({ title: "first" });
    await db.update(plugins).set({ manifestJson: manifest(a, [driver("replacement")]) }).where(eq(plugins.id, a));
    expect(await lookup(observed)).toBeNull();
  });

  it.each([null, true, "invalid", [], undefined])("preserves non-object schema behavior: %s", async value => {
    const first = driver(key, value);
    if (value === undefined) delete (first as Partial<PluginEnvironmentDriverDeclaration>).configSchema;
    await seed([first, driver(key, { properties: { secret: { format: "secret-ref" } } })]);
    const observed = observer();
    expect(await resolveSandboxProviderSecretRefPaths(observed, key)).toEqual(new Set());
    expect(await resolveSandboxProviderSecretRefPaths(observed, key)).toEqual(new Set());
  });

  it("returns independent schema objects and keeps separate database clients cold", async () => {
    await seed([driver(key, { description: "x".repeat(4096), properties: { token: { format: "secret-ref" } } })]);
    const a = observer(), b = observer();
    const first = await lookup(a);
    first!.properties = {};
    expect(await resolveSandboxProviderSecretRefPaths(a, key)).toEqual(new Set(["token"]));
    const warm = await measure(a, () => lookup(a)), independent = await measure(b, () => lookup(b));
    expect(warm.bytes).toBeLessThan(256);
    expect(independent.bytes).toBeGreaterThan(4096);
    warm.value!.properties = {};
    expect(await resolveSandboxProviderSecretRefPaths(a, key)).toEqual(new Set(["token"]));
  });

  it("bounds retained schemas and does not retain oversized definitions", async () => {
    const declarations = Array.from({ length: 33 }, (_, index) => driver(`provider-${index}`, { description: "x".repeat(2048) }));
    declarations.push(driver("oversized", { description: "x".repeat(128 * 1024) }));
    await seed(declarations);
    const observed = observer();
    for (let index = 0; index < 33; index++) await lookup(observed, `provider-${index}`);
    expect((await measure(observed, () => lookup(observed, "provider-32"))).bytes).toBeLessThan(256);
    expect((await measure(observed, () => lookup(observed, "provider-0"))).bytes).toBeGreaterThan(2048);
    await lookup(observed, "oversized");
    expect((await measure(observed, () => lookup(observed, "oversized"))).bytes).toBeGreaterThan(128 * 1024);
  });

  it("binds unusual keys and never serves retained schemas after a lookup error", async () => {
    const unusual = "provider-\"quoted' OR true --";
    await seed([driver(unusual, { title: "exact provider" })]);
    const observed = observer();
    let fail = false;
    const guarded = { execute: async (query: SQL) => {
      if (fail) throw new Error("fixture database unavailable");
      return observed.execute(query);
    } } as unknown as Db;
    expect((await lookup(guarded, unusual))).toEqual({ title: "exact provider" });
    fail = true;
    await expect(lookup(guarded, unusual)).rejects.toThrow("fixture database unavailable");
    fail = false;
    expect((await lookup(guarded, unusual))).toEqual({ title: "exact provider" });
    expect(await lookup(guarded, "unknown-provider")).toBeNull();
  });

  it("keeps each concurrent lookup tied to the database revision it observed", async () => {
    const id = await seed([driver(key, { title: "old" })]), observed = observer();
    let pause = false, release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const raced = { execute: async (query: SQL) => {
      const rows = await observed.execute(query);
      if (pause) { pause = false; reached(); await gate; }
      return rows;
    } } as unknown as Db;
    expect((await lookup(raced))).toEqual({ title: "old" });
    pause = true;
    const oldRead = lookup(raced);
    await paused;
    try {
      await db.update(plugins).set({ manifestJson: manifest(id, [driver(key, { title: "new" })]) }).where(eq(plugins.id, id));
      expect((await lookup(raced))).toEqual({ title: "new" });
    } finally { release(); }
    expect((await oldRead)).toEqual({ title: "old" });
    expect((await lookup(raced))).toEqual({ title: "new" });
    expect((await db.execute<{ title: string }>(sql`select ${plugins.manifestJson}->'environmentDrivers'->0->'configSchema'->>'title' as title from ${plugins} where ${plugins.id}=${id}`))[0].title).toBe("new");
  });
});
