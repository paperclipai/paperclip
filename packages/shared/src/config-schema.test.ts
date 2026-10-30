import { describe, expect, it } from "vitest";
import {
  findPaperclipConfigKeyWarnings,
  mergePaperclipConfig,
  paperclipConfigSchema,
  validatePaperclipConfig,
  migrateLegacyConfig,
  CONFIG_SECTIONS,
  CONFIG_SECTION_NAMES,
  getConfigSection,
  formatSectionOptions,
  formatAllConfigOptions,
} from "./config-schema.js";

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("retains extension keys at the top level and every nested config boundary", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
        extensionMeta: "keep",
      },
      database: {
        mode: "embedded-postgres",
        backup: {
          backupExtension: "keep",
        },
      },
      logging: {
        mode: "file",
      },
      server: {
        serverExtension: "keep",
      },
      storage: {
        localDisk: {
          driverExtension: "keep",
        },
        s3: {
          s3Extension: "keep",
        },
      },
      secrets: {
        localEncrypted: {
          providerExtension: "keep",
        },
      },
      topLevelExtension: {
        enabled: true,
      },
    });

    expect(parsed).toMatchObject({
      $meta: { extensionMeta: "keep" },
      database: { backup: { backupExtension: "keep" } },
      server: { serverExtension: "keep" },
      storage: {
        localDisk: { driverExtension: "keep" },
        s3: { s3Extension: "keep" },
      },
      secrets: { localEncrypted: { providerExtension: "keep" } },
      topLevelExtension: { enabled: true },
    });
  });

  it("merges retained extensions without resurrecting removed known fields", () => {
    const source = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      llm: {
        provider: "openai",
        apiKey: "remove-me",
        providerExtension: "keep",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { port: 3100, serverExtension: "keep" },
      topLevelExtension: "keep",
    });
    const update = paperclipConfigSchema.parse({
      ...source,
      llm: {
        provider: "openai",
      },
      server: {
        ...source.server,
        port: 3200,
      },
    });

    const merged = mergePaperclipConfig(source, update);

    expect(merged.server.port).toBe(3200);
    expect(merged.server.serverExtension).toBe("keep");
    expect(merged.topLevelExtension).toBe("keep");
    expect(merged.llm?.providerExtension).toBe("keep");
    expect(merged.llm).not.toHaveProperty("apiKey");
  });

  it("warns about likely misspellings while leaving arbitrary extensions alone", () => {
    expect(findPaperclipConfigKeyWarnings({
      servr: {},
      server: {
        ports: 3100,
        pluginOptions: {
          arbitrary: true,
        },
      },
      extensionNamespace: {
        port: 9999,
      },
    })).toEqual([
      { path: "servr", suggestion: "server" },
      { path: "server.ports", suggestion: "server.port" },
    ]);
  });

  it("suggests known field aliases for common naming guesses", () => {
    expect(findPaperclipConfigKeyWarnings({
      database: {
        url: "postgresql://localhost:5432/db",
      },
      auth: {
        publicUrl: "https://example.com",
      },
    })).toEqual([
      { path: "database.url", suggestion: "database.connectionString" },
      { path: "auth.publicUrl", suggestion: "auth.publicBaseUrl" },
    ]);
  });

  it("validates a valid configuration using validatePaperclipConfig", () => {
    const validConfig = {
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {
        port: 3100,
      },
    };

    const result = validatePaperclipConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.data?.database.mode).toBe("embedded-postgres");
  });

  it("detects invalid enum values and formats clear expected options", () => {
    const invalidConfig = {
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "external",
      },
      logging: {
        mode: "file",
      },
      server: {
        port: 3100,
      },
    };

    const result = validatePaperclipConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("database.mode") && e.includes("'embedded-postgres' | 'postgres'"))).toBe(true);
  });

  it("migrates legacy pglite configuration during validation", () => {
    const legacyConfig = {
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "pglite",
        pgliteDataDir: "/custom/data/dir",
        pglitePort: 54399,
      },
      logging: {
        mode: "file",
      },
      server: {
        port: 3100,
      },
    };

    const result = validatePaperclipConfig(legacyConfig);
    expect(result.valid).toBe(true);
    expect(result.data?.database.mode).toBe("embedded-postgres");
    expect(result.data?.database.embeddedPostgresDataDir).toBe("/custom/data/dir");
    expect(result.data?.database.embeddedPostgresPort).toBe(54399);
  });

  it("exports configuration sections and discovers options", () => {
    expect(CONFIG_SECTIONS.length).toBeGreaterThanOrEqual(9);
    expect(CONFIG_SECTION_NAMES).toContain("database");
    expect(CONFIG_SECTION_NAMES).toContain("server");
    expect(CONFIG_SECTION_NAMES).toContain("auth");

    const dbSection = getConfigSection("database");
    expect(dbSection).toBeDefined();
    expect(dbSection?.options.some((opt) => opt.key === "database.mode")).toBe(true);

    const formatted = formatSectionOptions(dbSection!);
    expect(formatted).toContain("database.mode: 'embedded-postgres' | 'postgres'");

    const allFormatted = formatAllConfigOptions();
    expect(allFormatted).toContain("Section: database");
    expect(allFormatted).toContain("Section: server");
  });
});
