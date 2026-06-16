import { describe, expect, it } from "vitest";
import { paperclipConfigSchema } from "./config-schema.js";

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

  function parseWithLogging(logging: Record<string, unknown>) {
    return paperclipConfigSchema.parse({
      $meta: { version: 1, updatedAt: "2026-05-10T00:00:00.000Z", source: "configure" },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file", ...logging },
      server: {},
    });
  }

  it("defaults logging.level to info when omitted", () => {
    expect(parseWithLogging({}).logging.level).toBe("info");
  });

  it("accepts debug and warn logging levels", () => {
    expect(parseWithLogging({ level: "debug" }).logging.level).toBe("debug");
    expect(parseWithLogging({ level: "warn" }).logging.level).toBe("warn");
  });

  it("rejects an unknown logging level", () => {
    expect(() => parseWithLogging({ level: "trace" })).toThrow();
  });
});
