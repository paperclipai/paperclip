import { describe, expect, it } from "vitest";
import { valadrienOsConfigSchema } from "./config-schema.js";

describe("valadrien-os config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = valadrienOsConfigSchema.parse({
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

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.valadrien-os/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.valadrien-os/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.valadrien-os/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.valadrien-os/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.valadrien-os/instances/default/secrets/master.key");
  });
});
