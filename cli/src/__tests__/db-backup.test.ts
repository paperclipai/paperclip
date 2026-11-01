import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";

vi.mock("@paperclipai/db", () => ({
  runDatabaseBackup: vi.fn(async () => ({
    backupFile: "/tmp/paperclip-backup.sql.gz",
    sizeBytes: 1024,
    prunedCount: 0,
  })),
  formatDatabaseBackupResult: (r: { backupFile: string; sizeBytes: number }) =>
    `${r.backupFile} (${r.sizeBytes}b)`,
}));

const bannerMock = vi.hoisted(() => vi.fn());
vi.mock("../utils/banner.js", () => ({
  printPaperclipCliBanner: bannerMock,
}));

const promptsMock = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { message: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock("@clack/prompts", () => promptsMock);

import { dbBackupCommand } from "../commands/db-backup.js";
import { runDatabaseBackup } from "@paperclipai/db";

function writeBaseConfig(configPath: string, port = 54329) {
  const base: PaperclipConfig = {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: port,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: "/tmp/paperclip-backups" },
    },
    logging: { mode: "file", logDir: "/tmp/paperclip-logs" },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(base, null, 2));
}

describe("dbBackupCommand connection resolution", () => {
  const originalEnv = { ...process.env };
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-db-backup-"));
    for (const k of ["DATABASE_URL", "PAPERCLIP_CONFIG", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      delete process.env[k];
    }
    vi.mocked(runDatabaseBackup).mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fails fast when the resolved config file is missing", async () => {
    const missing = path.join(tmpRoot, "does-not-exist", "config.json");
    await expect(dbBackupCommand({ config: missing, dir: tmpRoot })).rejects.toThrow(
      /no config found at .*does-not-exist.*config\.json/,
    );
    expect(runDatabaseBackup).not.toHaveBeenCalled();
  });

  it("fails fast when --data-dir points at a non-home directory (doubled instances path missing)", async () => {
    process.env.PAPERCLIP_HOME = path.join(tmpRoot, "instances", "CAL");
    process.env.PAPERCLIP_CONFIG = path.join(process.env.PAPERCLIP_HOME, "instances", "default", "config.json");
    await expect(dbBackupCommand({ dir: tmpRoot })).rejects.toThrow(
      /embedded-postgres@54329/,
    );
    expect(runDatabaseBackup).not.toHaveBeenCalled();
  });

  it("uses the per-instance embedded port when config is present", async () => {
    const configPath = path.join(tmpRoot, "config.json");
    writeBaseConfig(configPath, 54330);
    await dbBackupCommand({ config: configPath, dir: tmpRoot });
    expect(runDatabaseBackup).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runDatabaseBackup).mock.calls[0]![0];
    expect(call.connectionString).toBe("postgres://paperclip:paperclip@127.0.0.1:54330/paperclip");
  });

  it("honors DATABASE_URL even when config is missing", async () => {
    process.env.DATABASE_URL = "postgres://u:p@example.internal:5432/db";
    const missing = path.join(tmpRoot, "nope", "config.json");
    await dbBackupCommand({ config: missing, dir: tmpRoot });
    expect(runDatabaseBackup).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runDatabaseBackup).mock.calls[0]![0];
    expect(call.connectionString).toBe("postgres://u:p@example.internal:5432/db");
  });
});
