import { describe, expect, it } from "vitest";
import type { PaperclipConfig } from "@paperclipai/shared";
import { applyRuntimePortSelectionToConfig } from "./worktree-config.js";

// Helpers to build minimal PaperclipConfig shapes needed for these pure-function tests.

function makeEmbeddedConfig(serverPort: number, dbPort: number): PaperclipConfig {
  return {
    server: { port: serverPort },
    database: { mode: "embedded-postgres", embeddedPostgresPort: dbPort },
    auth: { baseUrlMode: "auto" },
  } as unknown as PaperclipConfig;
}

function makeExternalDbConfig(serverPort: number): PaperclipConfig {
  return {
    server: { port: serverPort },
    database: { mode: "postgres", connectionString: "postgres://localhost/test" },
    auth: { baseUrlMode: "auto" },
  } as unknown as PaperclipConfig;
}

function makeExplicitAuthConfig(
  serverPort: number,
  publicBaseUrl: string,
  dbPort = 54329,
): PaperclipConfig {
  return {
    server: { port: serverPort },
    database: { mode: "embedded-postgres", embeddedPostgresPort: dbPort },
    auth: { baseUrlMode: "explicit", publicBaseUrl },
  } as unknown as PaperclipConfig;
}

// ============================================================================
// applyRuntimePortSelectionToConfig — server port update
// ============================================================================

describe("applyRuntimePortSelectionToConfig — server port", () => {
  it("updates server port when it differs from input", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3200,
    });
    expect(next.server.port).toBe(3200);
    expect(changed).toBe(true);
  });

  it("does not change config when server port matches", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
    });
    expect(next.server.port).toBe(3100);
    expect(changed).toBe(false);
  });

  it("returns a new config object reference when changed", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next } = applyRuntimePortSelectionToConfig(config, { serverPort: 3200 });
    expect(next).not.toBe(config);
  });

  it("returns the original config reference when unchanged", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next } = applyRuntimePortSelectionToConfig(config, { serverPort: 3100 });
    expect(next).toBe(config);
  });

  it("skips server port update when allowServerPortWrite is false", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3200,
      allowServerPortWrite: false,
    });
    expect(next.server.port).toBe(3100);
    expect(changed).toBe(false);
  });
});

// ============================================================================
// applyRuntimePortSelectionToConfig — database port update
// ============================================================================

describe("applyRuntimePortSelectionToConfig — database port", () => {
  it("updates embedded-postgres port when it differs", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
      databasePort: 54330,
    });
    expect((next.database as { embeddedPostgresPort: number }).embeddedPostgresPort).toBe(54330);
    expect(changed).toBe(true);
  });

  it("does not change db port when it already matches", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
      databasePort: 54329,
    });
    expect(changed).toBe(false);
  });

  it("skips db port update when allowDatabasePortWrite is false", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
      databasePort: 54330,
      allowDatabasePortWrite: false,
    });
    expect((next.database as { embeddedPostgresPort: number }).embeddedPostgresPort).toBe(54329);
    expect(changed).toBe(false);
  });

  it("does not update db port for postgres mode (only embedded-postgres)", () => {
    const config = makeExternalDbConfig(3100);
    const { changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
      databasePort: 54330,
    });
    expect(changed).toBe(false);
  });

  it("does not update db port when databasePort is null", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
      databasePort: null,
    });
    expect(changed).toBe(false);
  });

  it("does not update db port when databasePort is undefined", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { changed } = applyRuntimePortSelectionToConfig(config, { serverPort: 3100 });
    expect(changed).toBe(false);
  });
});

// ============================================================================
// applyRuntimePortSelectionToConfig — auth publicBaseUrl port rewrite
// ============================================================================

describe("applyRuntimePortSelectionToConfig — auth URL port rewrite", () => {
  it("rewrites loopback publicBaseUrl port when baseUrlMode is explicit", () => {
    const config = makeExplicitAuthConfig(3100, "http://127.0.0.1:3100");
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3200,
    });
    expect(next.auth.publicBaseUrl).toBe("http://127.0.0.1:3200/");
    expect(changed).toBe(true);
  });

  it("rewrites localhost URL port when baseUrlMode is explicit", () => {
    const config = makeExplicitAuthConfig(3100, "http://localhost:3100");
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3201,
    });
    expect(next.auth.publicBaseUrl).toBe("http://localhost:3201/");
    expect(changed).toBe(true);
  });

  it("does not rewrite non-loopback publicBaseUrl", () => {
    // Use same serverPort as config to isolate URL-only behavior (no server-port change)
    const config = makeExplicitAuthConfig(3100, "https://app.example.com");
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3100,
    });
    expect(next.auth.publicBaseUrl).toBe("https://app.example.com");
    expect(changed).toBe(false);
  });

  it("does not rewrite URL when baseUrlMode is auto", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next, changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3200,
    });
    expect(next.auth.publicBaseUrl).toBeUndefined();
    expect(changed).toBe(true); // changed only because server port changed
  });

  it("does not mark changed when loopback URL port already matches", () => {
    // Use the normalized URL form (with trailing slash) so URL.toString() comparison is stable
    const config = makeExplicitAuthConfig(3100, "http://127.0.0.1:3100/");
    const { changed } = applyRuntimePortSelectionToConfig(config, { serverPort: 3100 });
    expect(changed).toBe(false);
  });
});

// ============================================================================
// applyRuntimePortSelectionToConfig — combined changes
// ============================================================================

describe("applyRuntimePortSelectionToConfig — combined changes", () => {
  it("marks changed when both server port and db port differ", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { changed } = applyRuntimePortSelectionToConfig(config, {
      serverPort: 3200,
      databasePort: 54330,
    });
    expect(changed).toBe(true);
  });

  it("preserves all other config fields unchanged", () => {
    const config = makeEmbeddedConfig(3100, 54329);
    const { config: next } = applyRuntimePortSelectionToConfig(config, { serverPort: 3200 });
    expect(next.auth).toEqual(config.auth);
    expect(next.database).toEqual(config.database);
  });
});
