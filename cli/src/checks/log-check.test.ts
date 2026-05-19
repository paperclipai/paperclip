import { describe, expect, it, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { logCheck } from "./log-check.js";
import type { PaperclipConfig } from "../config/schema.js";

/**
 * LET-436 regression: when an operator (or a stray env override) pins the
 * production `logging.logDir` to `/tmp/paperclip-vitest-*`, `paperclipai
 * doctor` must visibly fail the Log directory check. The directory disappears
 * between vitest runs and the heartbeat reaper then emits the `process_lost`
 * flood that drove LET-434/LET-436. This test exercises the real `logCheck`
 * factory used by the doctor command rather than the shared helper alone.
 */

const originalNodeEnv = process.env.NODE_ENV;

// CI sets TMPDIR=/tmp/paperclip-vitest-*/tmp, so os.tmpdir() itself lives
// inside a vitest scratch directory and any path mkdtemp'd under it would
// still match detectInsecureLogDir's vitest guard. For the "normal user
// logDir" pass case we need a base that is provably outside that hierarchy.
const VITEST_TEMPDIR_SEGMENT = /(^|\/)tmp\/paperclip-vitest-[^/]+/;
function nonVitestTmpBase(): string {
  let dir = os.tmpdir();
  while (VITEST_TEMPDIR_SEGMENT.test(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return VITEST_TEMPDIR_SEGMENT.test(dir) ? os.homedir() : dir;
}

function buildConfig(logDir: string): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-05-18T00:00:00.000Z",
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "~/.paperclip/instances/default/db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: "~/.paperclip/instances/default/data/backups",
      },
    },
    logging: { mode: "file", logDir },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "~/.paperclip/instances/default/data/storage" },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    },
    telemetry: { enabled: false },
    sandbox: { providers: { e2b: { enabled: false, apiKeySecret: null } } },
  } as unknown as PaperclipConfig;
}

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("LET-436 doctor logCheck flags insecure logDir", () => {
  it("fails the Log directory check when production logDir is /tmp/paperclip-vitest-*", () => {
    process.env.NODE_ENV = "production";
    const result = logCheck(buildConfig("/tmp/paperclip-vitest-leak/logs"));
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/vitest|tmp/i);
    expect(result.repairHint ?? "").toMatch(/stable path/);
  });

  it("passes for a normal user logDir", () => {
    process.env.NODE_ENV = "production";
    const baseDir = nonVitestTmpBase();
    const tmpRoot = fs.mkdtempSync(path.join(baseDir, "paperclip-logcheck-"));
    try {
      // Sanity: the fixture must not itself resemble a vitest scratch dir,
      // otherwise the LET-436 guard would (correctly) fail this path.
      expect(VITEST_TEMPDIR_SEGMENT.test(tmpRoot)).toBe(false);
      const result = logCheck(buildConfig(tmpRoot));
      expect(result.status).toBe("pass");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("permits vitest tempdirs when NODE_ENV=test (e.g. CI smoke runs)", () => {
    process.env.NODE_ENV = "test";
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-doctor-"));
    try {
      const result = logCheck(buildConfig(tmpRoot));
      // No insecure-logdir failure; either pass (writable) or fail on writability,
      // but the LET-436 guard must not be the reason.
      expect(result.message).not.toMatch(/vitest scratch directory/i);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
