import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, plugins, pluginConfigRuntime } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createPluginRuntimeConfigService,
  validateReservedKeys,
  RESERVED_KEYS,
  MAX_CONFIG_BYTES,
} from "../services/plugin-runtime-config.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-runtime-config tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions (no DB)
// ---------------------------------------------------------------------------

describe("validateReservedKeys (unit)", () => {
  it("accepts normal keys", () => {
    expect(() => validateReservedKeys({ foo: 1, bar: "baz", _ok: true })).not.toThrow();
  });

  it("rejects __proto__", () => {
    // Object literal { __proto__: {} } is intercepted by V8 (sets prototype, not own key).
    // The real attack vector is JSON-parsed input which produces an own key named "__proto__".
    const parsed = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    expect(() => validateReservedKeys(parsed)).toThrow(/reserved/i);
  });

  it("rejects constructor", () => {
    expect(() => validateReservedKeys({ constructor: {} })).toThrow(/reserved/i);
  });

  it("rejects prototype", () => {
    expect(() => validateReservedKeys({ prototype: {} })).toThrow(/reserved/i);
  });

  it("rejects keys with leading dot", () => {
    expect(() => validateReservedKeys({ ".foo": 1 })).toThrow(/reserved/i);
  });

  it("rejects keys with trailing dot", () => {
    expect(() => validateReservedKeys({ "foo.": 1 })).toThrow(/reserved/i);
  });

  it("rejects key that is only a dot", () => {
    expect(() => validateReservedKeys({ ".": 1 })).toThrow(/reserved/i);
  });

  it("rejects empty string key", () => {
    expect(() => validateReservedKeys({ "": 1 })).toThrow(/reserved/i);
  });

  it("accepts keys with internal dots", () => {
    expect(() => validateReservedKeys({ "a.b.c": 1 })).not.toThrow();
  });

  it("exposes RESERVED_KEYS for documentation", () => {
    expect(RESERVED_KEYS).toContain("__proto__");
    expect(RESERVED_KEYS).toContain("constructor");
    expect(RESERVED_KEYS).toContain("prototype");
  });

  it("exposes MAX_CONFIG_BYTES constant", () => {
    expect(MAX_CONFIG_BYTES).toBeGreaterThan(0);
    expect(MAX_CONFIG_BYTES).toBe(65536);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real DB
// ---------------------------------------------------------------------------

describeEmbeddedPostgres("plugin-runtime-config service (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof createPluginRuntimeConfigService>;
  let pluginId!: string;
  let pluginId2!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-runtime-config-");
    db = createDb(tempDb.connectionString);
    svc = createPluginRuntimeConfigService(db);

    // Seed two plugins
    pluginId = randomUUID();
    pluginId2 = randomUUID();
    await db.insert(plugins).values([
      {
        id: pluginId,
        pluginKey: "test.plugin.a",
        packageName: "@test/plugin-a",
        version: "0.0.1",
        manifestJson: {} as any,
        status: "installed",
      },
      {
        id: pluginId2,
        pluginKey: "test.plugin.b",
        packageName: "@test/plugin-b",
        version: "0.0.1",
        manifestJson: {} as any,
        status: "installed",
      },
    ]);
  }, 20_000);

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  afterEach(async () => {
    await db.delete(pluginConfigRuntime);
  });

  // -------------------------------------------------------------------------
  // get — no row
  // -------------------------------------------------------------------------

  it("getRuntime returns empty values and revision '0' when no row exists", async () => {
    const result = await svc.getRuntime(pluginId);
    expect(result).toEqual({ values: {}, revision: "0" });
  });

  // -------------------------------------------------------------------------
  // set — basic round-trip
  // -------------------------------------------------------------------------

  it("setRuntime creates a row on first write and returns revision '1'", async () => {
    const result = await svc.setRuntime(pluginId, { host: "https://git.example.com" });
    expect(result.revision).toBe("1");

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ host: "https://git.example.com" });
    expect(got.revision).toBe("1");
  });

  it("setRuntime merges with existing values", async () => {
    await svc.setRuntime(pluginId, { a: 1 });
    await svc.setRuntime(pluginId, { b: 2 });

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ a: 1, b: 2 });
    expect(got.revision).toBe("2");
  });

  it("setRuntime overwrites existing key with new value", async () => {
    await svc.setRuntime(pluginId, { a: "old" });
    await svc.setRuntime(pluginId, { a: "new" });

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ a: "new" });
  });

  it("revision is monotonically incrementing (10 sequential writes)", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await svc.setRuntime(pluginId, { i });
      expect(r.revision).toBe(String(i + 1));
    }
  });

  // -------------------------------------------------------------------------
  // set — reserved keys
  // -------------------------------------------------------------------------

  it("setRuntime rejects reserved key __proto__", async () => {
    // Object literal { __proto__: {} } is intercepted by V8; use JSON.parse for the real attack vector.
    const parsed = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    await expect(svc.setRuntime(pluginId, parsed)).rejects.toThrow(/reserved/i);
  });

  it("setRuntime rejects key with leading dot", async () => {
    await expect(svc.setRuntime(pluginId, { ".foo": 1 })).rejects.toThrow(/reserved/i);
  });

  it("setRuntime rejects key with trailing dot", async () => {
    await expect(svc.setRuntime(pluginId, { "foo.": 1 })).rejects.toThrow(/reserved/i);
  });

  it("setRuntime rejects empty key", async () => {
    await expect(svc.setRuntime(pluginId, { "": 1 })).rejects.toThrow(/reserved/i);
  });

  it("setRuntime rejects empty patch object", async () => {
    await expect(svc.setRuntime(pluginId, {})).rejects.toThrow(/empty/i);
  });

  // -------------------------------------------------------------------------
  // set — size limit
  // -------------------------------------------------------------------------

  it("setRuntime rejects patch that pushes merged config over 64KB", async () => {
    // Create a 65KB value
    const bigValue = "x".repeat(65 * 1024 + 100);
    await expect(svc.setRuntime(pluginId, { big: bigValue })).rejects.toThrow(/size.*limit|too large/i);
  });

  it("setRuntime accepts patch right at the boundary (63KB)", async () => {
    const value = "x".repeat(63 * 1024);
    const result = await svc.setRuntime(pluginId, { data: value });
    expect(result.revision).toBe("1");
  });

  // -------------------------------------------------------------------------
  // unset
  // -------------------------------------------------------------------------

  it("unsetRuntime removes an existing key", async () => {
    await svc.setRuntime(pluginId, { a: 1, b: 2 });
    await svc.unsetRuntime(pluginId, "a");

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ b: 2 });
    expect(got.revision).toBe("2");
  });

  it("unsetRuntime on non-existent key is a no-op (returns current revision)", async () => {
    await svc.setRuntime(pluginId, { a: 1 });
    const result = await svc.unsetRuntime(pluginId, "nonexistent");
    expect(result.revision).toBe("1");

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ a: 1 });
    expect(got.revision).toBe("1");
  });

  it("unsetRuntime treats inherited object properties as missing keys", async () => {
    await svc.setRuntime(pluginId, { a: 1 });
    const result = await svc.unsetRuntime(pluginId, "toString");
    expect(result.revision).toBe("1");

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({ a: 1 });
    expect(got.revision).toBe("1");
  });

  it("unsetRuntime on a plugin with no row is a no-op returning '0'", async () => {
    const result = await svc.unsetRuntime(pluginId, "key");
    expect(result.revision).toBe("0");
  });

  it("unsetRuntime rejects reserved key", async () => {
    await expect(svc.unsetRuntime(pluginId, "__proto__")).rejects.toThrow(/reserved/i);
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  it("clearRuntime resets values to empty object and increments revision", async () => {
    await svc.setRuntime(pluginId, { a: 1 });
    await svc.clearRuntime(pluginId);

    const got = await svc.getRuntime(pluginId);
    expect(got.values).toEqual({});
    expect(got.revision).toBe("2");
  });

  it("clearRuntime on plugin with no row is a no-op", async () => {
    await expect(svc.clearRuntime(pluginId)).resolves.not.toThrow();
    const got = await svc.getRuntime(pluginId);
    expect(got).toEqual({ values: {}, revision: "0" });
  });

  // -------------------------------------------------------------------------
  // Plugin isolation
  // -------------------------------------------------------------------------

  it("plugin A config is isolated from plugin B config", async () => {
    await svc.setRuntime(pluginId, { shared: "a-value" });

    const gotB = await svc.getRuntime(pluginId2);
    expect(gotB.values).toEqual({});
  });

  // -------------------------------------------------------------------------
  // ON DELETE CASCADE
  // -------------------------------------------------------------------------

  it("deleting the plugin row cascades to delete runtime config", async () => {
    await svc.setRuntime(pluginId, { a: 1 });

    await db.delete(plugins).where(eq(plugins.id, pluginId));

    const rows = await db.select().from(pluginConfigRuntime).where(
      eq(pluginConfigRuntime.pluginId, pluginId),
    );
    expect(rows).toHaveLength(0);

    // Re-seed plugin for future tests
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "test.plugin.a",
      packageName: "@test/plugin-a",
      version: "0.0.1",
      manifestJson: {} as any,
      status: "installed",
    });
  });
});
