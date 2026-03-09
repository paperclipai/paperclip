import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupRestoreStateSchema,
  backupRunSchema,
  type BackupRestoreState,
} from "@paperclipai/shared";
import type { Config } from "../config.js";

const { runDatabaseBackupMock, restoreDatabaseBackupMock } = vi.hoisted(() => ({
  runDatabaseBackupMock: vi.fn(),
  restoreDatabaseBackupMock: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  runDatabaseBackup: runDatabaseBackupMock,
  restoreDatabaseBackup: restoreDatabaseBackupMock,
}));

function makeConfig(instanceRoot: string): Config {
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
    embeddedPostgresDataDir: path.join(instanceRoot, "db"),
    embeddedPostgresPort: 5432,
    databaseBackupEnabled: true,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: path.join(instanceRoot, "data", "backups"),
    backupRequireSignedBackupsDefault: false,
    backupSigningSecret: undefined,
    backupSigningKeyId: undefined,
    backupRemoteProviderDefault: "none",
    backupRemoteS3BucketDefault: "",
    backupRemoteS3RegionDefault: "us-east-1",
    backupRemoteS3EndpointDefault: undefined,
    backupRemoteS3PrefixDefault: "",
    backupRemoteS3AccessKeyIdDefault: undefined,
    backupRemoteS3SecretAccessKeyDefault: undefined,
    backupRemoteS3ForcePathStyleDefault: false,
    backupRemoteS3DeleteOnDeleteDefault: false,
    backupRemoteS3ServerSideEncryptionDefault: "none",
    backupRemoteS3KmsKeyIdDefault: undefined,
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: path.join(instanceRoot, "secrets", "master.key"),
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: path.join(instanceRoot, "data", "storage"),
    storageS3Bucket: "",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 60000,
    companyDeletionEnabled: false,
  };
}

async function waitForRestoreState(filePath: string): Promise<BackupRestoreState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const state = backupRestoreStateSchema.parse(JSON.parse(raw));
      if (state.status !== "running") {
        return state;
      }
    } catch {
      // Restore writes the state file asynchronously; keep polling until it settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for restore to finish.");
}

describe("createBackupManager", () => {
  let previousHome: string | undefined;
  let tempHome: string;
  let instanceRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    runDatabaseBackupMock.mockReset();
    restoreDatabaseBackupMock.mockReset();

    previousHome = process.env.PAPERCLIP_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-backup-manager-"));
    process.env.PAPERCLIP_HOME = tempHome;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    instanceRoot = path.join(tempHome, "instances", "default");
    await fs.mkdir(path.join(instanceRoot, "data", "storage"), { recursive: true });
    await fs.mkdir(path.join(instanceRoot, "logs"), { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify({ instance: "test" }), "utf8");

    runDatabaseBackupMock.mockImplementation(async (opts: { backupDir: string }) => {
      await fs.mkdir(opts.backupDir, { recursive: true });
      const backupFile = path.join(opts.backupDir, "checkpoint.sql");
      await fs.writeFile(backupFile, "BEGIN;\nCOMMIT;\n", "utf8");
      return {
        backupFile,
        sizeBytes: 15,
        prunedCount: 0,
      };
    });
    restoreDatabaseBackupMock.mockImplementation(async (opts: { backupFile: string }) => ({
      backupFile: opts.backupFile,
      sizeBytes: 15,
    }));
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = previousHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("reports offsite replication as not configured when no remote provider is enabled", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const overview = await manager.getOverview();
    expect(overview.security.remoteReplicationConfigured).toBe(false);
    expect(overview.security.remoteReplicationHealthy).toBeNull();
  });

  it("completes a restore run and persists the final restore state", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const backupsDir = path.join(instanceRoot, "data", "backups");
    const bundleName = "backup-20260309T120000Z-restore";
    const bundlePath = path.join(backupsDir, bundleName);
    const databaseDir = path.join(bundlePath, "database");
    const databaseFile = path.join(databaseDir, "snapshot.sql");
    await fs.mkdir(databaseDir, { recursive: true });
    await fs.writeFile(databaseFile, "BEGIN;\nCOMMIT;\n", "utf8");
    await fs.writeFile(
      path.join(bundlePath, "manifest.json"),
      JSON.stringify(backupRunSchema.parse({
        id: "restore-source",
        origin: "local",
        status: "succeeded",
        triggerSource: "manual",
        startedAt: "2026-03-09T12:00:00.000Z",
        finishedAt: "2026-03-09T12:01:00.000Z",
        bundleName,
        bundlePath,
        totalSizeBytes: 15,
        prunedCount: 0,
        error: null,
        importedAt: null,
        importedBy: null,
        importSourceFilename: null,
        archivedAt: null,
        archivedBy: null,
        containsSensitiveData: false,
        integrity: null,
        signature: null,
        remoteCopies: [],
        components: [
          {
            key: "database",
            label: "Database",
            status: "included",
            relativePath: "database/snapshot.sql",
            absolutePath: databaseFile,
            sizeBytes: 15,
            itemCount: 1,
            notes: null,
          },
          {
            key: "storage",
            label: "Storage assets",
            status: "missing",
            relativePath: null,
            absolutePath: null,
            sizeBytes: 0,
            itemCount: 0,
            notes: "Source path does not exist.",
          },
          {
            key: "config",
            label: "Instance config",
            status: "missing",
            relativePath: null,
            absolutePath: null,
            sizeBytes: 0,
            itemCount: 0,
            notes: "No config files were found.",
          },
          {
            key: "env",
            label: "Instance env file",
            status: "skipped",
            relativePath: null,
            absolutePath: null,
            sizeBytes: null,
            itemCount: null,
            notes: null,
          },
          {
            key: "secretsKey",
            label: "Secrets master key",
            status: "skipped",
            relativePath: null,
            absolutePath: null,
            sizeBytes: null,
            itemCount: null,
            notes: null,
          },
          {
            key: "workspaces",
            label: "Agent workspaces",
            status: "skipped",
            relativePath: null,
            absolutePath: null,
            sizeBytes: null,
            itemCount: null,
            notes: null,
          },
        ],
      })),
      "utf8",
    );

    const initialState = await manager.restoreBackup("restore-source", "user-1");
    expect(initialState.status).toBe("running");

    const finalState = await waitForRestoreState(path.join(instanceRoot, "backup-restore-state.json"));
    expect(finalState.status).toBe("succeeded");
    expect(finalState.sourceBackupId).toBe("restore-source");
    expect(finalState.restoredComponents[0]?.key).toBe("database");
    expect(finalState.restoredComponents[0]?.status).toBe("included");
    expect(restoreDatabaseBackupMock).toHaveBeenCalledWith(expect.objectContaining({
      backupFile: databaseFile,
      dropExistingSchema: true,
    }));

    const checkpointRoot = path.join(backupsDir, "_restore-checkpoints");
    const checkpointEntries = await fs.readdir(checkpointRoot);
    expect(checkpointEntries).toHaveLength(0);
  });
});
