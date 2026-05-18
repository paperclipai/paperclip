import { describe, expect, it } from "vitest";
import { detectInsecureLogDir, paperclipConfigSchema } from "./config-schema.js";

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
});

// LET-436: A production server pointed at a `/tmp/paperclip-vitest-*` log
// directory means the deployment is reusing a vitest tempdir as its real
// log root — the directory disappears between runs, producing silent log
// loss and confusing the heartbeat reaper. Detect and refuse the config
// (or warn loudly when policy allows) so the failure is visible at startup
// rather than at recovery time.
describe("detectInsecureLogDir (LET-436)", () => {
  it("flags a vitest scratch logDir as insecure for non-test mode", () => {
    const result = detectInsecureLogDir("/tmp/paperclip-vitest-abc123/logs", { mode: "production" });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/vitest|tmp/i);
  });

  it("flags a bare /tmp/paperclip-vitest-... root directory", () => {
    const result = detectInsecureLogDir("/tmp/paperclip-vitest-xyz", { mode: "production" });
    expect(result.ok).toBe(false);
    expect(result.severity).toBe("error");
  });

  it("accepts a normal user logDir", () => {
    const result = detectInsecureLogDir("/home/user/.paperclip/instances/default/logs", { mode: "production" });
    expect(result.ok).toBe(true);
  });

  it("permits vitest tempdirs when explicit test mode is declared", () => {
    const result = detectInsecureLogDir("/tmp/paperclip-vitest-abc/logs", { mode: "test" });
    expect(result.ok).toBe(true);
  });

  it("treats unspecified mode as production (fails safe)", () => {
    const result = detectInsecureLogDir("/tmp/paperclip-vitest-abc/logs");
    expect(result.ok).toBe(false);
  });
});
