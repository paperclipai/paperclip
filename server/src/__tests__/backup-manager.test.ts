import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createTar, x as extractTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupRestoreStateSchema,
  backupRunSchema,
  type BackupRestoreState,
  type BackupRun,
} from "@paperclipai/shared";
import type { Config } from "../config.js";

const { runDatabaseBackupMock, runDatabaseRestoreMock, s3SendMock } = vi.hoisted(() => ({
  runDatabaseBackupMock: vi.fn(),
  runDatabaseRestoreMock: vi.fn(),
  s3SendMock: vi.fn(),
}));

vi.mock("@paperclipai/db", () => ({
  runDatabaseBackup: runDatabaseBackupMock,
  runDatabaseRestore: runDatabaseRestoreMock,
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send(command: unknown) {
      return s3SendMock(command);
    }
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));

function makeConfig(instanceRoot: string, overrides: Partial<Config> = {}): Config {
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3100,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
    databaseMigrationUrl: undefined,
    embeddedPostgresDataDir: path.join(instanceRoot, "db"),
    embeddedPostgresPort: 5432,
    databaseBackupEnabled: true,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: path.join(instanceRoot, "data", "backups"),
    // Restore tests model the isolated process explicitly. Production config
    // remains fail-closed (`PAPERCLIP_RESTORE_MAINTENANCE_MODE` defaults false).
    restoreMaintenanceMode: true,
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
    workspaceReaperCooldownDays: 7,
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
    feedbackExportBackendUrl: undefined,
    feedbackExportBackendToken: undefined,
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 60000,
    companyDeletionEnabled: false,
    telemetryEnabled: true,
    ...overrides,
  };
}

async function waitForRestoreState(filePath: string): Promise<BackupRestoreState> {
  const deadline = Date.now() + 5_000;
  await new Promise((resolve) => setTimeout(resolve, 750));
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for restore to finish.");
}

async function waitForBackupRun(filePath: string): Promise<BackupRun> {
  const deadline = Date.now() + 5_000;
  await new Promise((resolve) => setTimeout(resolve, 750));
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const run = backupRunSchema.parse(JSON.parse(raw));
      if (run.status !== "running") {
        return run;
      }
    } catch {
      // Snapshot writes the manifest asynchronously; keep polling until it settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for backup to finish.");
}

async function waitForRecoveryRollback(filePath: string): Promise<BackupRestoreState> {
  const deadline = Date.now() + 5_000;
  await new Promise((resolve) => setTimeout(resolve, 750));
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const state = backupRestoreStateSchema.parse(JSON.parse(raw));
      if (state.rollback.status !== "running" && state.rollback.finishedAt) {
        return state;
      }
    } catch {
      // Recovery writes the state file asynchronously; keep polling until it settles.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for interrupted restore recovery to finish.");
}

async function createRecoveryCheckpointFromBackup(opts: {
  sourceBundlePath: string;
  backupsDirectory: string;
  checkpointId: string;
  checkpointBundleName: string;
}): Promise<string> {
  const checkpointPath = path.join(
    opts.backupsDirectory,
    "_restore-checkpoints",
    opts.checkpointBundleName,
  );
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.cp(opts.sourceBundlePath, checkpointPath, { recursive: true });

  const manifestPath = path.join(checkpointPath, "manifest.json");
  const sourceManifest = backupRunSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const checkpointManifest = backupRunSchema.parse({
    ...sourceManifest,
    id: opts.checkpointId,
    bundleName: opts.checkpointBundleName,
    bundlePath: opts.checkpointBundleName,
    signature: null,
    remoteCopies: [],
  });
  await fs.writeFile(manifestPath, JSON.stringify(checkpointManifest), "utf8");
  return checkpointPath;
}

async function writeInterruptedRestoreState(opts: {
  instanceRoot: string;
  source: BackupRun;
  checkpointId: string | null;
  checkpointBundleName: string | null;
  status?: "running" | "recovery_required";
}): Promise<void> {
  const status = opts.status ?? "running";
  await fs.writeFile(
    path.join(opts.instanceRoot, "backup-restore-state.json"),
    JSON.stringify(backupRestoreStateSchema.parse({
      status,
      sourceBackupId: opts.source.id,
      sourceBundleName: opts.source.bundleName,
      startedAt: new Date(0).toISOString(),
      finishedAt: status === "running" ? null : new Date(0).toISOString(),
      error: null,
      notes: null,
      rollback: {
        status: "not_needed",
        checkpointBackupId: opts.checkpointId,
        checkpointBundleName: opts.checkpointBundleName,
        error: null,
        finishedAt: null,
      },
      restoredComponents: [],
    })),
    "utf8",
  );
}

describe("createBackupManager", () => {
  let previousHome: string | undefined;
  let tempHome: string;
  let instanceRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    runDatabaseBackupMock.mockReset();
    runDatabaseRestoreMock.mockReset();
    s3SendMock.mockReset();

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
    runDatabaseRestoreMock.mockResolvedValue(undefined);
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

  it("blocks portable backup and restore while an external database backup is running", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
      isExternalDatabaseBackupRunning: () => true,
    });

    await expect(manager.createManualBackup("user-1"))
      .rejects.toThrow("external database backup is running");
    await expect(manager.restoreBackup("missing-backup", "user-1"))
      .rejects.toThrow("external database backup is running");
    expect(manager.isOperationReserved()).toBe(false);
  });

  it("requires startup-only maintenance mode before restore or recovery can touch state", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot, { restoreMaintenanceMode: false }),
    });
    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    runDatabaseRestoreMock.mockClear();

    await expect(manager.restoreBackup(completedSource.id, "user-1"))
      .rejects.toThrow("PAPERCLIP_RESTORE_MAINTENANCE_MODE=true");
    await expect(manager.rollbackInterruptedRestore("user-1"))
      .rejects.toThrow("PAPERCLIP_RESTORE_MAINTENANCE_MODE=true");

    expect(runDatabaseRestoreMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(instanceRoot, "backup-restore-state.json"))).rejects.toThrow();
  });

  it("does not let a direct restore request mask a stale running restore state", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    const staleStartedAt = new Date(0).toISOString();
    await fs.writeFile(
      path.join(instanceRoot, "backup-restore-state.json"),
      JSON.stringify({
        status: "running",
        sourceBackupId: "stale-backup",
        sourceBundleName: "stale-bundle",
        startedAt: staleStartedAt,
        finishedAt: null,
        error: null,
        notes: null,
        restoredComponents: [],
      }),
      "utf8",
    );

    const initialState = await manager.restoreBackup(source.id, "user-1");
    expect(initialState.status).toBe("running");
    expect(manager.isRestoreRunning()).toBe(true);
    const state = await waitForRestoreState(path.join(instanceRoot, "backup-restore-state.json"));
    expect(state.status).toBe("succeeded");
    expect(state.sourceBackupId).toBe(source.id);
    expect(manager.isRestoreRunning()).toBe(false);
    expect(manager.isOperationReserved()).toBe(false);
  });

  it("requires rollback recovery before new backup or restore work after a stale checkpointed restore", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    await createRecoveryCheckpointFromBackup({
      sourceBundlePath: source.bundlePath,
      backupsDirectory: path.join(instanceRoot, "data", "backups"),
      checkpointId: "checkpoint-recovery-lock",
      checkpointBundleName: "checkpoint-recovery-lock",
    });
    await writeInterruptedRestoreState({
      instanceRoot,
      source,
      checkpointId: "checkpoint-recovery-lock",
      checkpointBundleName: "checkpoint-recovery-lock",
    });

    const overview = await manager.getOverview();
    expect(overview.restore.status).toBe("recovery_required");
    await expect(manager.createManualBackup("user-1"))
      .rejects.toThrow("recovery");
    await expect(manager.restoreBackup(source.id, "user-1"))
      .rejects.toThrow("recovery");
  });

  it("rolls back only the recorded verified checkpoint and unlocks an interrupted restore", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    const checkpointPath = await createRecoveryCheckpointFromBackup({
      sourceBundlePath: source.bundlePath,
      backupsDirectory: path.join(instanceRoot, "data", "backups"),
      checkpointId: "checkpoint-recovery-success",
      checkpointBundleName: "checkpoint-recovery-success",
    });
    await writeInterruptedRestoreState({
      instanceRoot,
      source,
      checkpointId: "checkpoint-recovery-success",
      checkpointBundleName: "checkpoint-recovery-success",
    });

    expect((await manager.getOverview()).restore.status).toBe("recovery_required");
    const initial = await manager.rollbackInterruptedRestore("user-1");
    expect(initial.rollback.status).toBe("running");
    expect(manager.isRestoreRunning()).toBe(true);

    const finalState = await waitForRecoveryRollback(path.join(instanceRoot, "backup-restore-state.json"));
    expect(finalState.status).toBe("failed");
    expect(finalState.rollback.status).toBe("succeeded");
    expect(finalState.rollback.checkpointBackupId).toBe("checkpoint-recovery-success");
    expect(runDatabaseRestoreMock).toHaveBeenCalledWith(expect.objectContaining({
      backupFile: path.join(checkpointPath, "database", "checkpoint.sql"),
    }));
    expect(manager.isRestoreRunning()).toBe(false);
    expect(manager.isOperationReserved()).toBe(false);
    await expect(manager.updateSettings({ intervalMinutes: 61 }, "user-1")).resolves.toMatchObject({
      intervalMinutes: 61,
    });
  });

  it("keeps the API restore barrier active immediately after restart with persisted recovery_required state", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const sourceManager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await sourceManager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    await createRecoveryCheckpointFromBackup({
      sourceBundlePath: source.bundlePath,
      backupsDirectory: path.join(instanceRoot, "data", "backups"),
      checkpointId: "checkpoint-restart-barrier",
      checkpointBundleName: "checkpoint-restart-barrier",
    });
    await writeInterruptedRestoreState({
      instanceRoot,
      source,
      checkpointId: "checkpoint-restart-barrier",
      checkpointBundleName: "checkpoint-restart-barrier",
      status: "recovery_required",
    });

    const restartedManager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    // `createBackupOperationBarrier` is synchronous, so this must be true
    // before an overview read can hydrate any in-memory state.
    expect(restartedManager.isRestoreRunning()).toBe(true);
    expect((await restartedManager.getOverview()).restore.status).toBe("recovery_required");
    await expect(restartedManager.createManualBackup("user-1"))
      .rejects.toThrow("recovery");

    const initial = await restartedManager.rollbackInterruptedRestore("user-1");
    expect(initial.rollback.status).toBe("running");
    const recovered = await waitForRecoveryRollback(path.join(instanceRoot, "backup-restore-state.json"));
    expect(recovered.rollback.status).toBe("succeeded");
    expect(restartedManager.isRestoreRunning()).toBe(false);
  });

  it("persists recovery_required when a component failure reaches the normal restore completion branch and rollback fails", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const sourceManager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await sourceManager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    const storageDestination = path.join(instanceRoot, "restore-target-parent", "storage");
    const storageParent = path.dirname(storageDestination);
    let restoreCall = 0;
    runDatabaseRestoreMock.mockImplementation(async () => {
      restoreCall += 1;
      if (restoreCall === 1) {
        // The source DB restore completes, then the next component observes a
        // target parent that became a file after preflight. Its failure is
        // returned as a component result rather than thrown.
        await fs.writeFile(storageParent, "not a directory", "utf8");
      }
      if (restoreCall === 2) {
        throw new Error("automatic rollback failed");
      }
    });
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      // This makes the source restore's storage component fail without
      // throwing, exercising the normal completion (`try`) branch.
      config: makeConfig(instanceRoot, {
        storageLocalDiskBaseDir: storageDestination,
      }),
    });

    const initial = await manager.restoreBackup(source.id, "user-1");
    expect(initial.status).toBe("running");
    const failed = await waitForRestoreState(path.join(instanceRoot, "backup-restore-state.json"));
    expect(failed.status).toBe("recovery_required");
    expect(failed.rollback.status).toBe("failed");
    expect(manager.isRestoreRunning()).toBe(true);
    await expect(manager.createManualBackup("user-1"))
      .rejects.toThrow("recovery");
    await expect(manager.restoreBackup(source.id, "user-1"))
      .rejects.toThrow("recovery");
    await expect(manager.tick(new Date(Date.now() + 2 * 60 * 60 * 1000))).resolves.toBeNull();

    const recovery = await manager.rollbackInterruptedRestore("user-1");
    expect(recovery.rollback.status).toBe("running");
    const recovered = await waitForRecoveryRollback(path.join(instanceRoot, "backup-restore-state.json"));
    expect(recovered.status).toBe("failed");
    expect(recovered.rollback.status).toBe("succeeded");
    expect(manager.isRestoreRunning()).toBe(false);
  });

  it("persists recovery_required when a thrown restore failure reaches the catch branch and rollback fails", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    let restoreCall = 0;
    runDatabaseRestoreMock.mockImplementation(async () => {
      restoreCall += 1;
      if (restoreCall <= 2) {
        throw new Error(restoreCall === 1 ? "source restore failed" : "automatic rollback failed");
      }
    });

    const initial = await manager.restoreBackup(source.id, "user-1");
    expect(initial.status).toBe("running");
    const failed = await waitForRestoreState(path.join(instanceRoot, "backup-restore-state.json"));
    expect(failed.status).toBe("recovery_required");
    expect(failed.rollback.status).toBe("failed");
    expect(manager.isRestoreRunning()).toBe(true);
    await expect(manager.createManualBackup("user-1"))
      .rejects.toThrow("recovery");
    await expect(manager.tick(new Date(Date.now() + 2 * 60 * 60 * 1000))).resolves.toBeNull();

    const recovery = await manager.rollbackInterruptedRestore("user-1");
    expect(recovery.rollback.status).toBe("running");
    const recovered = await waitForRecoveryRollback(path.join(instanceRoot, "backup-restore-state.json"));
    expect(recovered.status).toBe("failed");
    expect(recovered.rollback.status).toBe("succeeded");
    expect(manager.isRestoreRunning()).toBe(false);
  });

  it("never resolves a recovery checkpoint path from traversal data in restore state", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const source = await manager.createManualBackup("user-1");
    const completedSource = await waitForBackupRun(path.join(source.bundlePath, "manifest.json"));
    expect(completedSource.status).toBe("succeeded");

    await writeInterruptedRestoreState({
      instanceRoot,
      source,
      checkpointId: "checkpoint-traversal",
      checkpointBundleName: "../../outside-checkpoint",
    });

    expect((await manager.getOverview()).restore.status).toBe("recovery_required");
    await expect(manager.rollbackInterruptedRestore("user-1"))
      .rejects.toThrow("checkpoint");
    expect(runDatabaseRestoreMock).not.toHaveBeenCalled();
  });

  it("reserves a mutating operation before its first await", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const settingsUpdate = manager.updateSettings({ intervalMinutes: 61 }, "user-1");
    expect(manager.isOperationReserved()).toBe(true);
    await expect(manager.createManualBackup("user-1"))
      .rejects.toThrow("backup or restore operation is running");
    await settingsUpdate;
    expect(manager.isOperationReserved()).toBe(false);
  });

  it("keeps S3 static credentials out of public settings and manager state", async () => {
    const accessKeyId = "AKIA_TEST_NOT_FOR_STORAGE";
    const secretAccessKey = "test-secret-access-key";
    const settingsPath = path.join(instanceRoot, "backup-manager.json");
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        directory: path.join(instanceRoot, "data", "backups"),
        components: {
          storage: true,
          config: true,
          env: false,
          secretsKey: false,
          workspaces: false,
        },
        requireSignedBackups: false,
        remote: {
          provider: "s3",
          s3: {
            bucket: "portable-test-bucket",
            region: "us-east-1",
            endpoint: null,
            prefix: "",
            accessKeyId,
            secretAccessKey,
            forcePathStyle: false,
            deleteFromRemoteOnDelete: false,
            serverSideEncryption: "none",
            kmsKeyId: null,
          },
        },
      }),
      "utf8",
    );

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot, {
        backupRemoteProviderDefault: "s3",
        backupRemoteS3BucketDefault: "portable-test-bucket",
        backupRemoteS3AccessKeyIdDefault: accessKeyId,
        backupRemoteS3SecretAccessKeyDefault: secretAccessKey,
      }),
    });

    const overview = await manager.getOverview();
    expect(overview.settings.remote.s3).not.toHaveProperty("accessKeyId");
    expect(overview.settings.remote.s3).not.toHaveProperty("secretAccessKey");
    expect(JSON.stringify(overview)).not.toContain(accessKeyId);
    expect(JSON.stringify(overview)).not.toContain(secretAccessKey);

    const persisted = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain(accessKeyId);
    expect(JSON.stringify(persisted)).not.toContain(secretAccessKey);
    expect((persisted.remote as { s3: Record<string, unknown> }).s3).not.toHaveProperty("accessKeyId");
    expect((persisted.remote as { s3: Record<string, unknown> }).s3).not.toHaveProperty("secretAccessKey");
  });

  it("creates a portable config projection without manager settings, local paths, or secret-like values", async () => {
    const sourceConnection = "postgres://source-user:source-password@source.example/source";
    const sourceApiKey = "source-api-key";
    const sourceExtensionToken = "source-extension-token";
    const sourceBackupDir = path.join(tempHome, "source-machine", "backups");
    const sourceStorageDir = path.join(tempHome, "source-machine", "storage");
    const sourceLogDir = path.join(tempHome, "source-machine", "logs");
    const sourceSecretsKey = path.join(tempHome, "source-machine", "master.key");
    const sourceCachePath = path.join(tempHome, "source-machine", "cache");
    await fs.writeFile(
      path.join(instanceRoot, "config.json"),
      JSON.stringify({
        database: {
          mode: "postgres",
          connectionString: sourceConnection,
          embeddedPostgresDataDir: path.join(tempHome, "source-machine", "database"),
          backup: {
            dir: sourceBackupDir,
            retentionDays: 90,
          },
        },
        logging: {
          mode: "file",
          logDir: sourceLogDir,
        },
        storage: {
          provider: "local_disk",
          localDisk: {
            baseDir: sourceStorageDir,
          },
        },
        secrets: {
          provider: "local_encrypted",
          localEncrypted: {
            keyFilePath: sourceSecretsKey,
          },
        },
        llm: {
          provider: "openai",
          apiKey: sourceApiKey,
        },
        server: {
          host: "source-host",
          port: 3131,
        },
        auth: {
          baseUrlMode: "explicit",
          publicBaseUrl: "https://source.example",
        },
        portableFeature: {
          enabled: true,
          cachePath: sourceCachePath,
          nested: {
            accessToken: sourceExtensionToken,
            safeValue: "kept",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(instanceRoot, "backup-manager.json"),
      JSON.stringify({ enabled: true, directory: path.join(instanceRoot, "data", "backups") }),
      "utf8",
    );
    let releaseDatabaseBackup: (() => void) | undefined;
    const databaseBackupGate = new Promise<void>((resolve) => {
      releaseDatabaseBackup = resolve;
    });
    runDatabaseBackupMock.mockImplementation(async (opts: { backupDir: string }) => {
      await databaseBackupGate;
      await fs.mkdir(opts.backupDir, { recursive: true });
      const backupFile = path.join(opts.backupDir, "checkpoint.sql");
      await fs.writeFile(backupFile, "BEGIN;\nCOMMIT;\n", "utf8");
      return {
        backupFile,
        sizeBytes: 15,
        prunedCount: 0,
      };
    });

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const initialRun = await manager.createManualBackup("user-1");
    expect(manager.isOperationReserved()).toBe(true);
    expect(await manager.tick(new Date(Date.now() + 2 * 60 * 60 * 1000))).toBeNull();
    await expect(manager.updateSettings({ intervalMinutes: 90 }, "user-1"))
      .rejects.toThrow("backup or restore operation is running");
    await expect(manager.importBackupArchive(path.join(tempHome, "missing.tar.gz"), "missing.tar.gz", "user-1"))
      .rejects.toThrow("backup or restore operation is running");
    await expect(manager.archiveBackup("missing-backup", "user-1"))
      .rejects.toThrow("backup or restore operation is running");
    await expect(manager.unarchiveBackup("missing-backup", "user-1"))
      .rejects.toThrow("backup or restore operation is running");
    await expect(manager.deleteBackup("missing-backup", "user-1"))
      .rejects.toThrow("backup or restore operation is running");
    releaseDatabaseBackup?.();
    const finalRun = await waitForBackupRun(path.join(initialRun.bundlePath, "manifest.json"));
    expect(finalRun.status).toBe("succeeded");
    expect(manager.isOperationReserved()).toBe(false);
    expect(runDatabaseBackupMock).toHaveBeenCalledWith(expect.objectContaining({
      retention: {
        dailyDays: 3650,
        weeklyWeeks: 520,
        monthlyMonths: 120,
      },
    }));

    await expect(fs.access(path.join(initialRun.bundlePath, "config", "backup-manager.json"))).rejects.toThrow();
    const portableConfig = JSON.parse(
      await fs.readFile(path.join(initialRun.bundlePath, "config", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const serialized = JSON.stringify(portableConfig);
    for (const omittedValue of [
      sourceConnection,
      sourceApiKey,
      sourceExtensionToken,
      sourceBackupDir,
      sourceStorageDir,
      sourceLogDir,
      sourceSecretsKey,
      sourceCachePath,
    ]) {
      expect(serialized).not.toContain(omittedValue);
    }
    expect(portableConfig).not.toHaveProperty("server");
    expect(portableConfig).not.toHaveProperty("auth");
    expect(portableConfig).toMatchObject({
      database: {
        mode: "postgres",
        backup: {
          retentionDays: 90,
        },
      },
      llm: {
        provider: "openai",
      },
      portableFeature: {
        enabled: true,
        nested: {
          safeValue: "kept",
        },
      },
    });
  });

  it("uploads an archive with a finalized signed manifest", async () => {
    const uploadedArchivePath = path.join(tempHome, "remote-copy.tar.gz");
    s3SendMock.mockImplementation(async (command: unknown) => {
      const archivePath = (
        command as { input?: { Body?: { path?: string } } }
      ).input?.Body?.path;
      if (!archivePath) throw new Error("Expected the S3 upload command to contain an archive stream.");
      await fs.copyFile(archivePath, uploadedArchivePath);
      return { ETag: "remote-etag" };
    });

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot, {
        backupSigningSecret: "test-signing-secret",
        backupSigningKeyId: "test-key",
        backupRemoteProviderDefault: "s3",
        backupRemoteS3BucketDefault: "portable-test-bucket",
      }),
    });

    const initialRun = await manager.createManualBackup("user-1");
    const finalRun = await waitForBackupRun(path.join(initialRun.bundlePath, "manifest.json"));
    expect(finalRun.status).toBe("succeeded");
    expect(s3SendMock).toHaveBeenCalledTimes(1);

    const extractedArchivePath = path.join(tempHome, "remote-archive");
    await fs.mkdir(extractedArchivePath, { recursive: true });
    await extractTar({ file: uploadedArchivePath, cwd: extractedArchivePath });
    const archivedManifest = backupRunSchema.parse(JSON.parse(
      await fs.readFile(path.join(extractedArchivePath, initialRun.bundleName, "manifest.json"), "utf8"),
    ));
    expect(archivedManifest.status).toBe("succeeded");
    expect(archivedManifest.signature).toMatchObject({
      algorithm: "hmac-sha256",
      keyId: "test-key",
    });
    expect(archivedManifest.remoteCopies).toEqual([]);
    expect(archivedManifest.bundlePath).toBe(initialRun.bundleName);
    expect(archivedManifest.components.every((component) => component.absolutePath === null)).toBe(true);
    expect(JSON.stringify(archivedManifest)).not.toContain(instanceRoot);
  });

  it("discards untrusted remote copy metadata when importing an unsigned backup", async () => {
    const archiveRoot = path.join(tempHome, "crafted-import");
    const bundleName = "imported-untrusted-remote-copy";
    const bundlePath = path.join(archiveRoot, bundleName);
    const archivePath = path.join(tempHome, "crafted-import.tar.gz");
    await fs.mkdir(bundlePath, { recursive: true });
    await fs.writeFile(
      path.join(bundlePath, "manifest.json"),
      JSON.stringify(backupRunSchema.parse({
        id: "imported-untrusted-remote-copy",
        origin: "local",
        status: "succeeded",
        triggerSource: "manual",
        startedAt: "2026-03-09T12:00:00.000Z",
        finishedAt: "2026-03-09T12:01:00.000Z",
        bundleName,
        bundlePath: bundleName,
        totalSizeBytes: 0,
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
        remoteCopies: [{
          provider: "s3",
          status: "uploaded",
          bucket: "unrelated-bucket",
          region: "us-east-1",
          endpoint: null,
          key: "outside-configured-prefix/valuable-object",
          sizeBytes: 1,
          uploadedAt: "2026-03-09T12:01:00.000Z",
          etag: null,
          notes: null,
        }],
        components: [],
      })),
      "utf8",
    );
    await createTar({ gzip: true, file: archivePath, cwd: archiveRoot }, [bundleName]);

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot, {
        backupRemoteProviderDefault: "s3",
        backupRemoteS3BucketDefault: "configured-bucket",
        backupRemoteS3DeleteOnDeleteDefault: true,
      }),
    });

    const imported = await manager.importBackupArchive(archivePath, "crafted-import.tar.gz", "user-1");
    expect(imported.remoteCopies).toEqual([]);
    await manager.deleteBackup(imported.id, "user-1");
    expect(s3SendMock).not.toHaveBeenCalled();
  });

  it("writes host-neutral manifests with canonical POSIX component paths", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const initialRun = await manager.createManualBackup("user-1");
    const manifest = await waitForBackupRun(path.join(initialRun.bundlePath, "manifest.json"));

    expect(manifest.bundlePath).toBe(initialRun.bundleName);
    expect(manifest.components.every((component) => component.absolutePath === null)).toBe(true);
    expect(manifest.components
      .flatMap((component) => component.relativePath ? [component.relativePath] : [])
      .every((relativePath) => !relativePath.includes("\\")))
      .toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(instanceRoot);
  });

  it("fails a portable snapshot rather than copying a selected filesystem symlink", async () => {
    const outsideDirectory = path.join(tempHome, "outside-storage-directory");
    const linkedStorageDirectory = path.join(instanceRoot, "data", "storage", "outside-link");
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "outside.txt"), "outside backup root", "utf8");
    // Windows permits junctions without Developer Mode or elevated symlink
    // privileges; lstat still identifies them as symbolic links.
    await fs.symlink(outsideDirectory, linkedStorageDirectory, process.platform === "win32" ? "junction" : "dir");

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    const initialRun = await manager.createManualBackup("user-1");
    const finalRun = await waitForBackupRun(path.join(initialRun.bundlePath, "manifest.json"));
    const storage = finalRun.components.find((component) => component.key === "storage");

    expect(finalRun.status).toBe("failed");
    expect(finalRun.integrity).toBeNull();
    expect(storage).toMatchObject({ status: "failed" });
    expect(storage?.notes).toContain("symbolic link");
    await expect(fs.lstat(path.join(initialRun.bundlePath, "storage"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a crafted local bundle symlink during restore preflight", async () => {
    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    const initialRun = await manager.createManualBackup("user-1");
    const completedRun = await waitForBackupRun(path.join(initialRun.bundlePath, "manifest.json"));
    expect(completedRun.status).toBe("succeeded");

    const outsideDirectory = path.join(tempHome, "outside-restore-directory");
    const bundleLink = path.join(initialRun.bundlePath, "storage", "outside-link");
    await fs.mkdir(outsideDirectory, { recursive: true });
    await fs.writeFile(path.join(outsideDirectory, "outside.txt"), "must not be restored", "utf8");
    await fs.symlink(outsideDirectory, bundleLink, process.platform === "win32" ? "junction" : "dir");

    await expect(manager.previewRestore(completedRun.id)).rejects.toThrow(/symbolic link/i);
    await expect(manager.restoreBackup(completedRun.id, "user-1")).rejects.toThrow(/symbolic link/i);
    expect(runDatabaseRestoreMock).not.toHaveBeenCalled();

    const restoreState = backupRestoreStateSchema.parse(JSON.parse(
      await fs.readFile(path.join(instanceRoot, "backup-restore-state.json"), "utf8"),
    ));
    expect(restoreState.status).toBe("failed");
    expect(restoreState.notes).toContain("preflight");
  });

  it("rejects traversal and drive-qualified component paths from legacy manifests", async () => {
    const backupsDir = path.join(instanceRoot, "data", "backups");
    const makeUnsafeManifest = (id: string, bundleName: string, relativePath: string) => backupRunSchema.parse({
      id,
      origin: "imported",
      status: "succeeded",
      triggerSource: "manual",
      startedAt: "2026-03-09T12:00:00.000Z",
      finishedAt: "2026-03-09T12:01:00.000Z",
      bundleName,
      bundlePath: "C:\\source-machine\\backups\\legacy",
      totalSizeBytes: 1,
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
      components: [{
        key: "database",
        label: "Database",
        status: "included",
        relativePath,
        absolutePath: "C:\\source-machine\\backups\\legacy\\database.sql",
        sizeBytes: 1,
        itemCount: 1,
        notes: null,
      }],
    });

    for (const [id, bundleName, relativePath] of [
      ["unsafe-traversal", "unsafe-traversal", "database\\..\\..\\escape.sql"],
      ["unsafe-drive", "unsafe-drive", "C:\\escape.sql"],
      ["unsafe-nested-drive", "unsafe-nested-drive", "database\\D:escape.sql"],
    ]) {
      const bundlePath = path.join(backupsDir, bundleName);
      await fs.mkdir(bundlePath, { recursive: true });
      await fs.writeFile(
        path.join(bundlePath, "manifest.json"),
        JSON.stringify(makeUnsafeManifest(id, bundleName, relativePath)),
        "utf8",
      );
    }

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });

    expect((await manager.getOverview()).backups).toEqual([]);
  });

  it("completes a restore run and persists the final restore state", async () => {
    const targetConnection = "postgres://target-user:target-password@target.example/target";
    const targetBackupDir = path.join(tempHome, "target-machine", "backups");
    const targetDatabaseDir = path.join(tempHome, "target-machine", "database");
    const targetStorageDir = path.join(tempHome, "target-machine", "storage");
    const targetLogDir = path.join(tempHome, "target-machine", "logs");
    const targetSecretsKey = path.join(tempHome, "target-machine", "master.key");
    const targetCachePath = path.join(tempHome, "target-machine", "cache");
    const targetConfig = {
      database: {
        mode: "embedded-postgres",
        connectionString: targetConnection,
        embeddedPostgresDataDir: targetDatabaseDir,
        backup: {
          dir: targetBackupDir,
          retentionDays: 14,
        },
      },
      logging: {
        mode: "file",
        logDir: targetLogDir,
      },
      storage: {
        provider: "local_disk",
        localDisk: {
          baseDir: targetStorageDir,
        },
      },
      secrets: {
        provider: "local_encrypted",
        localEncrypted: {
          keyFilePath: targetSecretsKey,
        },
      },
      llm: {
        provider: "claude",
        apiKey: "target-llm-api-key",
      },
      server: {
        host: "target-host",
        port: 3200,
      },
      auth: {
        baseUrlMode: "explicit",
        publicBaseUrl: "https://target.example",
      },
      portableFeature: {
        existingTargetValue: true,
        localCachePath: targetCachePath,
      },
    };
    await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify(targetConfig), "utf8");

    const { createBackupManager } = await import("../services/backups.js");
    const manager = createBackupManager({
      connectionString: "postgres://paperclip:test@127.0.0.1:5432/paperclip_test",
      config: makeConfig(instanceRoot),
    });
    await manager.updateSettings({ intervalMinutes: 17 }, "target-admin");
    const targetManagerSettings = await fs.readFile(path.join(instanceRoot, "backup-manager.json"), "utf8");

    const backupsDir = path.join(instanceRoot, "data", "backups");
    const bundleName = "backup-20260309T120000Z-restore";
    const bundlePath = path.join(backupsDir, bundleName);
    const databaseDir = path.join(bundlePath, "database");
    const databaseFile = path.join(databaseDir, "snapshot.sql");
    const sourceConfigDir = path.join(bundlePath, "config");
    await fs.mkdir(databaseDir, { recursive: true });
    await fs.writeFile(databaseFile, "BEGIN;\nCOMMIT;\n", "utf8");
    await fs.mkdir(sourceConfigDir, { recursive: true });
    const sourceConnection = "postgres://source-user:source-password@source.example/source";
    const sourceExtensionToken = "source-extension-token";
    const sourceCachePath = path.join(tempHome, "source-machine", "cache");
    await fs.writeFile(
      path.join(sourceConfigDir, "config.json"),
      JSON.stringify({
        database: {
          mode: "postgres",
          connectionString: sourceConnection,
          embeddedPostgresDataDir: path.join(tempHome, "source-machine", "database"),
          backup: {
            dir: path.join(tempHome, "source-machine", "backups"),
            retentionDays: 365,
          },
        },
        logging: {
          mode: "cloud",
          logDir: path.join(tempHome, "source-machine", "logs"),
        },
        storage: {
          provider: "local_disk",
          localDisk: {
            baseDir: path.join(tempHome, "source-machine", "storage"),
          },
        },
        secrets: {
          provider: "local_encrypted",
          localEncrypted: {
            keyFilePath: path.join(tempHome, "source-machine", "master.key"),
          },
        },
        llm: {
          provider: "openai",
          apiKey: "source-llm-api-key",
        },
        server: {
          host: "source-host",
          port: 3131,
        },
        auth: {
          baseUrlMode: "explicit",
          publicBaseUrl: "https://source.example",
        },
        portableFeature: {
          restoredSourceValue: true,
          cachePath: sourceCachePath,
          accessToken: sourceExtensionToken,
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(sourceConfigDir, "backup-manager.json"),
      JSON.stringify({
        directory: path.join(tempHome, "source-machine", "backups"),
        remote: {
          provider: "s3",
          s3: {
            accessKeyId: "source-manager-access-key",
            secretAccessKey: "source-manager-secret",
          },
        },
      }),
      "utf8",
    );
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
        bundlePath: `C:\\source-machine\\backups\\${bundleName}`,
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
            relativePath: "database\\snapshot.sql",
            absolutePath: `C:\\source-machine\\backups\\${bundleName}\\database\\snapshot.sql`,
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
            status: "included",
            relativePath: "config",
            absolutePath: `C:\\source-machine\\backups\\${bundleName}\\config`,
            sizeBytes: 0,
            itemCount: 2,
            notes: null,
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

    const scannedSource = await manager.getBackupById("restore-source");
    const scannedDatabase = scannedSource.components.find((component) => component.key === "database");
    expect(scannedSource.bundlePath).toBe(bundlePath);
    expect(scannedDatabase).toMatchObject({
      relativePath: "database/snapshot.sql",
      absolutePath: databaseFile,
    });

    const initialState = await manager.restoreBackup("restore-source", "user-1");
    expect(initialState.status).toBe("running");
    expect(manager.isRestoreRunning()).toBe(true);
    expect(manager.isOperationReserved()).toBe(true);

    const finalState = await waitForRestoreState(path.join(instanceRoot, "backup-restore-state.json"));
    expect(finalState.status).toBe("succeeded");
    expect(manager.isOperationReserved()).toBe(false);
    expect(finalState.sourceBackupId).toBe("restore-source");
    expect(finalState.restoredComponents[0]?.key).toBe("database");
    expect(finalState.restoredComponents[0]?.status).toBe("included");
    expect(finalState.restoredComponents.find((component) => component.key === "config")?.notes)
      .toContain("Backup manager settings are instance-local and were not restored.");
    expect(runDatabaseRestoreMock).toHaveBeenCalledWith(expect.objectContaining({
      backupFile: databaseFile,
    }));
    expect(runDatabaseRestoreMock.mock.calls[0]?.[0]).not.toHaveProperty("dropExistingSchema");

    const restoredConfig = JSON.parse(await fs.readFile(path.join(instanceRoot, "config.json"), "utf8"));
    expect(restoredConfig).toMatchObject({
      database: {
        mode: "postgres",
        connectionString: targetConnection,
        embeddedPostgresDataDir: targetDatabaseDir,
        backup: {
          dir: targetBackupDir,
          retentionDays: 365,
        },
      },
      logging: {
        mode: "cloud",
        logDir: targetLogDir,
      },
      storage: {
        localDisk: {
          baseDir: targetStorageDir,
        },
      },
      secrets: {
        localEncrypted: {
          keyFilePath: targetSecretsKey,
        },
      },
      llm: {
        provider: "openai",
        apiKey: "target-llm-api-key",
      },
      server: targetConfig.server,
      auth: targetConfig.auth,
      portableFeature: {
        existingTargetValue: true,
        localCachePath: targetCachePath,
        restoredSourceValue: true,
      },
    });
    expect(JSON.stringify(restoredConfig)).not.toContain(sourceConnection);
    expect(JSON.stringify(restoredConfig)).not.toContain(sourceExtensionToken);
    expect(JSON.stringify(restoredConfig)).not.toContain(sourceCachePath);
    expect(await fs.readFile(path.join(instanceRoot, "backup-manager.json"), "utf8"))
      .toBe(targetManagerSettings);

    const checkpointRoot = path.join(backupsDir, "_restore-checkpoints");
    const checkpointEntries = await fs.readdir(checkpointRoot);
    expect(checkpointEntries).toHaveLength(0);
  });
});
