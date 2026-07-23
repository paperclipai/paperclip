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

  it("defaults log rotation size and file count when omitted", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: {},
    });

    expect(parsed.logging.maxSizeMb).toBe(200);
    expect(parsed.logging.maxFiles).toBe(10);
  });

  it("honours operator-provided log rotation overrides", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file", maxSizeMb: 50, maxFiles: 5 },
      server: {},
    });

    expect(parsed.logging.maxSizeMb).toBe(50);
    expect(parsed.logging.maxFiles).toBe(5);
  });
});
