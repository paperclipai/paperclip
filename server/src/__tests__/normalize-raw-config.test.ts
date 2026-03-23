import { describe, it, expect } from "vitest";
import { normalizeRawConfig, paperclipConfigSchema } from "@paperclipai/shared";

describe("normalizeRawConfig", () => {
  it("returns non-object input unchanged", () => {
    expect(normalizeRawConfig(null)).toBeNull();
    expect(normalizeRawConfig("string")).toBe("string");
    expect(normalizeRawConfig(42)).toBe(42);
    expect(normalizeRawConfig([1, 2])).toEqual([1, 2]);
  });

  // --- database.mode value aliases ---
  it('maps database.mode "external" → "postgres"', () => {
    const raw = { database: { mode: "external" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("postgres");
  });

  it('maps database.mode "postgresql" → "postgres"', () => {
    const raw = { database: { mode: "postgresql" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("postgres");
  });

  it('maps database.mode "embedded" → "embedded-postgres"', () => {
    const raw = { database: { mode: "embedded" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("embedded-postgres");
  });

  it('maps legacy database.mode "pglite" with field migration', () => {
    const raw = { database: { mode: "pglite", pgliteDataDir: "/tmp/db", pglitePort: 5433 } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("embedded-postgres");
    expect(result.database.embeddedPostgresDataDir).toBe("/tmp/db");
    expect(result.database.embeddedPostgresPort).toBe(5433);
  });

  it("does not overwrite existing embeddedPostgresDataDir during pglite migration", () => {
    const raw = {
      database: { mode: "pglite", embeddedPostgresDataDir: "/existing", pgliteDataDir: "/old" },
    };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.embeddedPostgresDataDir).toBe("/existing");
  });

  it("leaves valid database.mode unchanged", () => {
    const raw = { database: { mode: "postgres" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("postgres");
  });

  // --- database field aliases ---
  it("maps database.url → database.connectionString", () => {
    const raw = { database: { mode: "postgres", url: "postgres://localhost/db" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.connectionString).toBe("postgres://localhost/db");
    expect(result.database.url).toBeUndefined();
  });

  it("maps database.databaseUrl → database.connectionString", () => {
    const raw = { database: { mode: "postgres", databaseUrl: "postgres://localhost/db" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.connectionString).toBe("postgres://localhost/db");
    expect(result.database.databaseUrl).toBeUndefined();
  });

  it("does not overwrite existing connectionString with alias", () => {
    const raw = {
      database: { mode: "postgres", connectionString: "postgres://real", url: "postgres://alias" },
    };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.connectionString).toBe("postgres://real");
  });

  // --- auth aliases ---
  it('maps auth.baseUrlMode "manual" → "explicit"', () => {
    const raw = { auth: { baseUrlMode: "manual" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.auth.baseUrlMode).toBe("explicit");
  });

  it("maps auth.publicUrl → auth.publicBaseUrl", () => {
    const raw = { auth: { publicUrl: "https://example.com" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.auth.publicBaseUrl).toBe("https://example.com");
    expect(result.auth.publicUrl).toBeUndefined();
  });

  // --- server aliases ---
  it('maps server.deploymentMode "trusted" → "local_trusted"', () => {
    const raw = { server: { deploymentMode: "trusted" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.server.deploymentMode).toBe("local_trusted");
  });

  it('maps server.deploymentMode "auth" → "authenticated"', () => {
    const raw = { server: { deploymentMode: "auth" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.server.deploymentMode).toBe("authenticated");
  });

  // --- integration: normalized config passes Zod validation ---
  it("normalized aliased config passes schema validation", () => {
    const raw = {
      $meta: { version: 1, updatedAt: "2026-01-01", source: "onboard" },
      database: { mode: "external", url: "postgres://localhost:5432/paperclip" },
      logging: { mode: "file" },
      server: { deploymentMode: "trusted" },
      auth: { baseUrlMode: "auto" },
    };

    const normalized = normalizeRawConfig(raw);
    const result = paperclipConfigSchema.safeParse(normalized);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.database.mode).toBe("postgres");
      expect(result.data.database.connectionString).toBe("postgres://localhost:5432/paperclip");
      expect(result.data.server.deploymentMode).toBe("local_trusted");
    }
  });

  // --- no-op for missing sections ---
  it("handles config with no database/auth/server sections", () => {
    const raw = { foo: "bar" };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.foo).toBe("bar");
    expect(result.database).toBeUndefined();
  });

  // --- case insensitivity ---
  it("handles mixed-case value aliases", () => {
    const raw = { database: { mode: "External" } };
    const result = normalizeRawConfig(raw) as Record<string, any>;
    expect(result.database.mode).toBe("postgres");
  });
});
