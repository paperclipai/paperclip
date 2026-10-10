import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.ts";

// Regression tests for KEWL-3955/KEWL-3960: the config integrity guard must
// fire when the *canonical* config is poisoned with pcvt-* vitest temp paths,
// and must NOT fire when an isolated test instance's own config (at a
// non-canonical path) legitimately contains pcvt-* paths.

// A minimal schema-valid config whose data dirs all live under `pcvtRoot`.
function buildPoisonedConfig(pcvtRoot: string) {
  return {
    $meta: {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      source: "configure" as const,
    },
    database: {
      mode: "embedded-postgres" as "embedded-postgres" | "postgres",
      connectionString: undefined as string | undefined,
      embeddedPostgresDataDir: path.join(pcvtRoot, "db"),
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: path.join(pcvtRoot, "data", "backups"),
      },
    },
    logging: {
      mode: "file" as const,
      logDir: path.join(pcvtRoot, "logs"),
    },
    server: {
      deploymentMode: "local_trusted" as const,
      exposure: "private" as const,
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "explicit" as const,
      publicBaseUrl: "http://127.0.0.1:3100",
      disableSignUp: false,
    },
    storage: {
      provider: "local_disk" as "local_disk" | "s3",
      localDisk: {
        baseDir: path.join(pcvtRoot, "data", "storage"),
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted" as "local_encrypted" | "aws_secrets_manager",
      strictMode: false,
      localEncrypted: {
        keyFilePath: path.join(pcvtRoot, "secrets", "master.key"),
      },
    },
  };
}

function buildConfigWithPoisonedOverrideablePaths(pcvtRoot: string, safeRoot: string) {
  const config = buildPoisonedConfig(safeRoot);
  config.database.backup.dir = path.join(pcvtRoot, "data", "backups");
  config.storage.localDisk.baseDir = path.join(pcvtRoot, "data", "storage");
  config.secrets.localEncrypted.keyFilePath = path.join(pcvtRoot, "secrets", "master.key");
  return config;
}

describe("config integrity guard (KEWL-3955 / KEWL-3960)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when the canonical config contains pcvt-* vitest temp paths", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-integrity-guard-canonical-"));
    try {
      const instanceDir = path.join(home, "instances", "default");
      await fs.mkdir(instanceDir, { recursive: true });
      const configPath = path.join(instanceDir, "config.json");
      const pcvtRoot = "/tmp/pcvt-84842-1-xJU1sf";
      await fs.writeFile(configPath, JSON.stringify(buildPoisonedConfig(pcvtRoot), null, 2), "utf8");

      vi.stubEnv("PAPERCLIP_HOME", home);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      // Set PAPERCLIP_CONFIG explicitly to the canonical path so resolvePaperclipConfigPath()
      // and resolveDefaultConfigPath() both agree — avoid ancestor traversal surprises in CI.
      vi.stubEnv("PAPERCLIP_CONFIG", configPath);
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "");

      expect(() => loadConfig()).toThrow(/Config integrity check failed.*KEWL-3955/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("uses env-overridden effective paths before rejecting a canonical config", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-integrity-guard-overrides-"));
    try {
      const instanceDir = path.join(home, "instances", "default");
      await fs.mkdir(instanceDir, { recursive: true });
      const configPath = path.join(instanceDir, "config.json");
      const pcvtRoot = "/tmp/pcvt-84842-3-override";
      const safeRoot = path.join(process.cwd(), ".paperclip-integrity-guard-safe-runtime");
      await fs.writeFile(
        configPath,
        JSON.stringify(buildConfigWithPoisonedOverrideablePaths(pcvtRoot, safeRoot), null, 2),
        "utf8",
      );

      vi.stubEnv("PAPERCLIP_HOME", home);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      vi.stubEnv("PAPERCLIP_CONFIG", configPath);
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "");
      vi.stubEnv("PAPERCLIP_DB_BACKUP_DIR", path.join(safeRoot, "env-backups"));
      vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(safeRoot, "env-storage"));
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(safeRoot, "env-secrets", "master.key"));

      const config = loadConfig();
      expect(config.databaseBackupDir).toBe(path.join(safeRoot, "env-backups"));
      expect(config.storageLocalDiskBaseDir).toBe(path.join(safeRoot, "env-storage"));
      expect(config.secretsMasterKeyFilePath).toBe(path.join(safeRoot, "env-secrets", "master.key"));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does NOT throw when stale pcvt-* paths are in inactive provider sections", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-integrity-guard-inactive-"));
    try {
      const instanceDir = path.join(home, "instances", "default");
      await fs.mkdir(instanceDir, { recursive: true });
      const configPath = path.join(instanceDir, "config.json");
      const pcvtRoot = "/tmp/pcvt-84842-4-inactive";
      const safeRoot = path.join(process.cwd(), ".paperclip-integrity-guard-safe-runtime");
      const config = buildPoisonedConfig(safeRoot);
      config.database.mode = "postgres";
      config.database.connectionString = "postgresql://paperclip:paperclip@127.0.0.1:5432/paperclip";
      config.database.embeddedPostgresDataDir = path.join(pcvtRoot, "db");
      config.storage.provider = "s3";
      config.storage.localDisk.baseDir = path.join(pcvtRoot, "data", "storage");
      config.secrets.provider = "aws_secrets_manager";
      config.secrets.localEncrypted.keyFilePath = path.join(pcvtRoot, "secrets", "master.key");
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

      vi.stubEnv("PAPERCLIP_HOME", home);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      vi.stubEnv("PAPERCLIP_CONFIG", configPath);
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "");
      vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
      vi.stubEnv("PAPERCLIP_SECRETS_PROVIDER", "aws_secrets_manager");

      const loaded = loadConfig();
      expect(loaded.databaseUrl).toBe(config.database.connectionString);
      expect(loaded.storageProvider).toBe("s3");
      expect(loaded.secretsProvider).toBe("aws_secrets_manager");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("does NOT throw when a non-canonical pcvt-* scoped config contains pcvt-* paths (KEWL-3960)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-integrity-guard-isolated-"));
    try {
      // Simulate an e2e CLI test: it writes its own config at a temp path,
      // sets PAPERCLIP_CONFIG to that path, and boots its own isolated instance.
      // That config legitimately has pcvt-* data dirs — the guard must stay silent.
      const isolatedDir = path.join(home, "isolated-instance");
      await fs.mkdir(isolatedDir, { recursive: true });
      const isolatedConfigPath = path.join(isolatedDir, "config.json");
      const pcvtRoot = "/tmp/pcvt-3142-2-3Mug0r";
      await fs.writeFile(
        isolatedConfigPath,
        JSON.stringify(buildPoisonedConfig(pcvtRoot), null, 2),
        "utf8",
      );

      // Point PAPERCLIP_HOME at a different dir so the canonical path has no file.
      // Point PAPERCLIP_CONFIG at the isolated config explicitly.
      vi.stubEnv("PAPERCLIP_HOME", home);
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      vi.stubEnv("PAPERCLIP_CONFIG", isolatedConfigPath);
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "");

      // Must not throw: the guard sees a non-canonical path and skips.
      expect(() => loadConfig()).not.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
