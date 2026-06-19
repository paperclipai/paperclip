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

  it("leaves logging.format optional, accepts json, and rejects unknown values", () => {
    const base = {
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: { mode: "embedded-postgres" },
      server: {},
    } as const;

    // Omitted → undefined (the logger applies the "pretty" default).
    const omitted = paperclipConfigSchema.parse({ ...base, logging: { mode: "file" } });
    expect(omitted.logging.format).toBeUndefined();

    const json = paperclipConfigSchema.parse({ ...base, logging: { mode: "file", format: "json" } });
    expect(json.logging.format).toBe("json");

    expect(() =>
      paperclipConfigSchema.parse({ ...base, logging: { mode: "file", format: "xml" } }),
    ).toThrow();
  });
});
