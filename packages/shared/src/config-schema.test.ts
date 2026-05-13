import { describe, expect, it } from "vitest";
import { odysseusConfigSchema } from "./config-schema.js";

describe("odysseus config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = odysseusConfigSchema.parse({
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

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.odysseus/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.odysseus/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.odysseus/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.odysseus/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.odysseus/instances/default/secrets/master.key");
  });
});
