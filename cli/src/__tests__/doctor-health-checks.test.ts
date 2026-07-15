import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { activityLogSizeCheck } from "../checks/activity-log-size-check.js";
import { plannerStatsCheck } from "../checks/planner-stats-check.js";
import { serverLogSizeCheck } from "../checks/server-log-size-check.js";
import { sharedBuffersCheck } from "../checks/shared-buffers-check.js";

const tempRoots: string[] = [];

function createConfig(overrides: Partial<PaperclipConfig> = {}): PaperclipConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-doctor-health-"));
  tempRoots.push(root);

  return {
    $meta: {
      version: 1,
      updatedAt: "2026-07-15T00:00:00.000Z",
      source: "doctor",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(root, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: path.join(root, "backups"),
      },
    },
    logging: {
      mode: "file",
      logDir: path.join(root, "logs"),
    },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    telemetry: {
      enabled: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk",
      localDisk: {
        baseDir: path.join(root, "storage"),
      },
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
        keyFilePath: path.join(root, "secrets", "master.key"),
      },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("plannerStatsCheck", () => {
  it("repairs stale hot-table statistics with ANALYZE", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ relname: "activity_log" }, { relname: "issues" }])
      .mockResolvedValue([]);
    const openDb = vi.fn(async () => ({ db: { execute } as never, connectionString: "postgres://test" }));

    const result = await plannerStatsCheck(createConfig(), undefined, { openDb });

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(true);
    expect(result.message).toContain("activity_log");
    expect(result.message).toContain("issues");

    await result.repair?.();

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1]?.[0]).toBe('ANALYZE "activity_log"');
    expect(execute.mock.calls[2]?.[0]).toBe('ANALYZE "issues"');
  });

  it("warns without repair when PostgreSQL is unavailable", async () => {
    const openDb = vi.fn(async () => {
      throw new Error("connection refused");
    });

    const result = await plannerStatsCheck(createConfig(), undefined, { openDb });

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(false);
    expect(result.message).toContain("skipped");
  });
});

describe("activityLogSizeCheck", () => {
  it("warns and recommends VACUUM FULL above the size threshold", async () => {
    const execute = vi.fn().mockResolvedValue([{ total_bytes: "4097" }]);
    const openDb = vi.fn(async () => ({ db: { execute } as never, connectionString: "postgres://test" }));

    const result = await activityLogSizeCheck(createConfig(), undefined, {
      maxBytes: 4096,
      openDb,
    });

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(false);
    expect(result.message).toContain("activity_log");
    expect(result.repairHint).toContain("VACUUM FULL");
  });
});

describe("serverLogSizeCheck", () => {
  it("copy-truncates an oversized server.log", async () => {
    const config = createConfig();
    fs.mkdirSync(config.logging.logDir, { recursive: true });
    const logFile = path.join(config.logging.logDir, "server.log");
    fs.writeFileSync(logFile, "0123456789");

    const result = serverLogSizeCheck(config, undefined, {
      maxBytes: 8,
      now: () => new Date("2026-07-15T12:34:56.000Z"),
    });

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(true);
    await result.repair?.();

    expect(fs.statSync(logFile).size).toBe(0);
    const rotatedPath = path.join(config.logging.logDir, "server.log.2026-07-15T12-34-56-000Z");
    expect(fs.readFileSync(rotatedPath, "utf8")).toBe("0123456789");
  });
});

describe("sharedBuffersCheck", () => {
  it("configures embedded PostgreSQL shared_buffers to 25% of host RAM", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          setting: "16384",
          unit: "8kB",
          pending_restart: false,
          configured_setting: null,
        },
      ])
      .mockResolvedValue([]);
    const openDb = vi.fn(async () => ({ db: { execute } as never, connectionString: "postgres://test" }));

    const result = await sharedBuffersCheck(createConfig(), undefined, {
      hostMemoryBytes: 8 * 1024 ** 3,
      openDb,
    });

    expect(result.status).toBe("warn");
    expect(result.canRepair).toBe(true);
    expect(result.message).toContain("128 MiB");
    expect(result.message).toContain("2 GiB");

    await result.repair?.();

    expect(execute.mock.calls[1]?.[0]).toBe("ALTER SYSTEM SET shared_buffers = '2048MB'");
    expect(execute.mock.calls[2]?.[0]).toBe("SELECT pg_reload_conf()");
  });

  it("does not inspect shared_buffers for externally managed PostgreSQL", async () => {
    const config = createConfig({
      database: {
        mode: "postgres",
        connectionString: "postgres://example.test/paperclip",
        embeddedPostgresDataDir: "/unused",
        embeddedPostgresPort: 54329,
        backup: {
          enabled: true,
          intervalMinutes: 60,
          retentionDays: 7,
          dir: "/unused",
        },
      },
    });
    const openDb = vi.fn();

    const result = await sharedBuffersCheck(config, undefined, { openDb });

    expect(result.status).toBe("pass");
    expect(openDb).not.toHaveBeenCalled();
  });
});
