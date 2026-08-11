import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  databaseBackupEmitterLeaseReleaseMock,
  databaseBackupLeaseReleaseMock,
  detectPortMock,
  deriveAuthTrustedOriginsMock,
  environmentCustomImagesServiceMock,
  environmentCustomImagesServiceFactoryMock,
  executionWorkspaceServiceFactoryMock,
  executionWorkspaceServiceMock,
  externalObjectsServiceMock,
  externalObjectsServiceFactoryMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
  heartbeatServiceFactoryMock,
  heartbeatServiceMock,
  issueThreadInteractionServiceFactoryMock,
  issueThreadInteractionServiceMock,
  loadConfigMock,
  resolveHeartbeatSchedulingSuppressionMock,
  runDatabaseBackupMock,
  routineServiceFactoryMock,
  routineServiceMock,
  systemdNotifyMock,
  tryAcquireDatabaseBackupEmitterLeaseMock,
  tryAcquireDatabaseBackupLeaseMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
  }) as never);
  const neverLost = new Promise<void>(() => {});
  const databaseBackupEmitterLeaseReleaseMock = vi.fn(async () => undefined);
  const databaseBackupLeaseReleaseMock = vi.fn(async () => undefined);
  const detectPortMock = vi.fn(async (port: number) => port);
  const deriveAuthTrustedOriginsMock = vi.fn(() => []);
  const resolveHeartbeatSchedulingSuppressionMock = vi.fn(() => ({
    suppressed: false,
    reason: null,
  }));
  const heartbeatServiceMock = {
    resolveSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
    reconcileHotRestartAdoption: vi.fn(async () => ({ mode: "none" })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [],
    })),
    reconcileIssueGraphLiveness: vi.fn(async () => ({
      escalationsCreated: 0,
      dependencyWakesHealed: 0,
    })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
    reconcileProductivityReviews: vi.fn(async () => ({ created: 0, updated: 0, failed: 0 })),
    sweepExpiredRuntimeStatuses: vi.fn(() => 0),
    tickTimers: vi.fn(async () => ({ checked: 0, enqueued: 0, skipped: 0 })),
  };
  const heartbeatServiceFactoryMock = vi.fn(() => heartbeatServiceMock);
  const issueThreadInteractionServiceMock = {
    sweepSupersededPendingRequestConfirmations: vi.fn(async () => ({ expired: 0 })),
    sweepMergedPullRequestConfirmations: vi.fn(async () => ({
      checked: 0,
      candidates: 0,
      accepted: 0,
      woken: 0,
    })),
  };
  const issueThreadInteractionServiceFactoryMock = vi.fn(() => issueThreadInteractionServiceMock);
  const environmentCustomImagesServiceMock = {
    cleanupExpiredSetupSessions: vi.fn(async () => ({ scanned: 0, timedOut: 0, failed: 0 })),
  };
  const environmentCustomImagesServiceFactoryMock = vi.fn(() => environmentCustomImagesServiceMock);
  const executionWorkspaceServiceMock = {
    sweepTerminalWorkspaces: vi.fn(async () => ({
      checked: 0,
      eligible: 0,
      archived: 0,
      cleanupFailed: 0,
      skippedActiveRun: 0,
      skippedNonTerminalTree: 0,
      skippedUndelivered: 0,
      skippedRace: 0,
    })),
  };
  const executionWorkspaceServiceFactoryMock = vi.fn(() => executionWorkspaceServiceMock);
  const externalObjectsServiceMock = {
    refreshDueObjectsForActiveCompanies: vi.fn(async () => ({ companies: 0, checked: 0, refreshed: 0 })),
  };
  const externalObjectsServiceFactoryMock = vi.fn(() => externalObjectsServiceMock);
  const routineServiceMock = {
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  };
  const routineServiceFactoryMock = vi.fn(() => routineServiceMock);
  const systemdNotifyMock = vi.fn(async () => false);
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };
  const loadConfigMock = vi.fn();
  const runDatabaseBackupMock = vi.fn(async () => ({
    backupFile: "/tmp/paperclip-test-backups/paperclip-test.sql.gz",
    sizeBytes: 1024,
    prunedCount: 0,
  }));
  const tryAcquireDatabaseBackupLeaseMock = vi.fn(
    async () => ({
      lost: neverLost,
      isHeld: () => true,
      release: databaseBackupLeaseReleaseMock,
    }),
  );
  const tryAcquireDatabaseBackupEmitterLeaseMock = vi.fn(async () => ({
    lost: neverLost,
    isHeld: () => true,
    release: databaseBackupEmitterLeaseReleaseMock,
  }));

  return {
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    databaseBackupEmitterLeaseReleaseMock,
    databaseBackupLeaseReleaseMock,
    detectPortMock,
    deriveAuthTrustedOriginsMock,
    environmentCustomImagesServiceMock,
    environmentCustomImagesServiceFactoryMock,
    executionWorkspaceServiceFactoryMock,
    executionWorkspaceServiceMock,
    externalObjectsServiceMock,
    externalObjectsServiceFactoryMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
    heartbeatServiceFactoryMock,
    heartbeatServiceMock,
    issueThreadInteractionServiceFactoryMock,
    issueThreadInteractionServiceMock,
    loadConfigMock,
    resolveHeartbeatSchedulingSuppressionMock,
    runDatabaseBackupMock,
    routineServiceFactoryMock,
    routineServiceMock,
    systemdNotifyMock,
    tryAcquireDatabaseBackupEmitterLeaseMock,
    tryAcquireDatabaseBackupLeaseMock,
  };
});

function buildTestConfig(overrides: Record<string, unknown> = {}) {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3210,
    allowedHostnames: [],
    authBaseUrlMode: "auto",
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseMode: "postgres",
    databaseUrl: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
    embeddedPostgresDataDir: "/tmp/paperclip-test-db",
    embeddedPostgresPort: 54329,
    databaseBackupEnabled: false,
    databaseBackupSingletonEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    feedbackExportBackendUrl: "https://telemetry.example.com",
    feedbackExportBackendToken: "telemetry-token",
    heartbeatSchedulerEnabled: false,
    heartbeatSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  ensurePostgresDatabase: vi.fn(),
  getPostgresDataDirectory: vi.fn(),
  inspectMigrations: vi.fn(async () => ({ status: "upToDate" })),
  applyPendingMigrations: vi.fn(),
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: runDatabaseBackupMock,
  tryAcquireDatabaseBackupEmitterLease: tryAcquireDatabaseBackupEmitterLeaseMock,
  tryAcquireDatabaseBackupLease: tryAcquireDatabaseBackupLeaseMock,
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  backfillLegacyToolOAuthTokens: vi.fn(async () => ({
    scannedConnections: 0,
    migratedConnections: 0,
    sanitizedConnections: 0,
    createdSecrets: 0,
    rotatedSecrets: 0,
    accessTokensBackfilled: 0,
    refreshTokensBackfilled: 0,
  })),
  backfillPrincipalAccessCompatibility: vi.fn(async () => ({
    agentMembershipsInserted: 0,
    humanGrantsInserted: 0,
  })),
  attentionService: vi.fn(() => ({
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
  })),
  decisionService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => ({ expired: 0 })),
  })),
  decisionRetentionService: vi.fn(() => ({
    autoArchive: vi.fn(async () => 0),
    deliverNotifications: vi.fn(async () => ({ notifiedAgents: 0, delivered: 0 })),
  })),
  feedbackService: feedbackServiceFactoryMock,
  bootstrapExecutionPolicyFromEnv: vi.fn(async () => null),
  applyManagedEnvironments: vi.fn(async () => null),
  environmentCustomImageService: environmentCustomImagesServiceFactoryMock,
  executionWorkspaceService: executionWorkspaceServiceFactoryMock,
  externalObjectService: externalObjectsServiceFactoryMock,
  heartbeatService: heartbeatServiceFactoryMock,
  issueThreadInteractionService: issueThreadInteractionServiceFactoryMock,
  issueService: vi.fn(() => ({ update: vi.fn(async () => null) })),
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn(async () => ({
      enableExternalObjects: true,
      enableStatusCards: false,
    })),
    getGeneral: vi.fn(async () => ({
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    })),
  })),
  reconcileCodexLocalManagedHomesOnStartup: vi.fn(async () => ({
    scanned: 0,
    seeded: 0,
    alreadySeeded: 0,
    externalOverride: 0,
    noManagedHome: 0,
    sourceAuthMissing: 0,
    failed: 0,
    seededAgentIds: [],
  })),
  reconcileBuiltInAgentsOnStartup: vi.fn(async () => ({
    scanned: 0,
    reconciled: 0,
    unknown: 0,
    duplicates: 0,
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  resolveHeartbeatSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
  routineService: routineServiceFactoryMock,
  statusCardService: vi.fn(() => ({})),
  toolAccessService: vi.fn(() => ({
    sweepConnectionHealth: vi.fn(async () => ({
      checked: 0,
      healthy: 0,
      needsAttention: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/secret-proposals.js", () => ({
  createSecretProposalsService: vi.fn(() => ({
    sweepExpired: vi.fn(async () => 0),
  })),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({ id: "plugin-worker-manager" })),
}));

vi.mock("../services/database-backup-health.js", () => ({
  inspectDatabaseBackupHealth: vi.fn(() => ({ latestBackup: null })),
}));

vi.mock("../services/systemd-notify.js", () => ({
  systemdNotify: systemdNotifyMock,
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../board-claim.js", () => ({
  getBoardClaimWarningUrl: vi.fn(() => null),
  initializeBoardClaimChallenge: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: createBetterAuthInstanceMock,
  deriveAuthTrustedOrigins: deriveAuthTrustedOriginsMock,
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";

const startupSignals = ["SIGINT", "SIGTERM"] as const;
let signalListenersBeforeTest = new Map<(typeof startupSignals)[number], Function[]>();

beforeEach(() => {
  signalListenersBeforeTest = new Map(
    startupSignals.map((signal) => [signal, process.listeners(signal)]),
  );
});

afterEach(() => {
  for (const signal of startupSignals) {
    const retained = new Set(signalListenersBeforeTest.get(signal) ?? []);
    for (const listener of process.listeners(signal)) {
      if (!retained.has(listener)) process.removeListener(signal, listener);
    }
  }
});

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "0123456789abcdef0123456789abcdef";
    loadConfigMock.mockReturnValue(buildTestConfig());
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: false,
      reason: null,
    });
    systemdNotifyMock.mockReset();
    systemdNotifyMock.mockResolvedValue(false);
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("starts without PAPERCLIP_DECISION_SIGNING_SECRET by generating a persisted key", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-"));
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const started = await startServer();
      expect(started.server).toBe(fakeServer);
      const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
      expect(readFileSync(keyPath, "utf8").trim().length).toBeGreaterThanOrEqual(32);
      if (process.platform !== "win32") {
        expect(statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("repairs permissive permissions on an existing generated decision signing key", async () => {
    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-mode-"));
    const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
    const existingKey = Buffer.alloc(32, 7).toString("base64");
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o777 });
    chmodSync(path.dirname(keyPath), 0o777);
    writeFileSync(keyPath, existingKey, { encoding: "utf8", mode: 0o644 });
    chmodSync(keyPath, 0o644);
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      const started = await startServer();
      expect(started.server).toBe(fakeServer);
      expect(readFileSync(keyPath, "utf8")).toBe(existingKey);
      if (process.platform !== "win32") {
        expect(statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("refuses a symlink planted as the generated decision signing key", async () => {
    if (process.platform === "win32") return;

    const originalHome = process.env.PAPERCLIP_HOME;
    const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    const tempHome = mkdtempSync(path.join(tmpdir(), "paperclip-decision-key-symlink-"));
    const keyPath = path.join(tempHome, "instances", "default", "secrets", "decision-signing.key");
    const plantedTarget = path.join(tempHome, "planted.key");
    const plantedKey = Buffer.alloc(32, 9).toString("base64");
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o777 });
    chmodSync(path.dirname(keyPath), 0o777);
    writeFileSync(plantedTarget, plantedKey, { encoding: "utf8", mode: 0o600 });
    symlinkSync(plantedTarget, keyPath);
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    delete process.env.PAPERCLIP_DECISION_SIGNING_SECRET;
    try {
      await expect(startServer()).rejects.toThrow("must be a regular file");
      expect(readFileSync(plantedTarget, "utf8")).toBe(plantedKey);
    } finally {
      if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = originalHome;
      if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("refuses startup when an explicit decision signing secret is too short", async () => {
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "too-short";
    await expect(startServer()).rejects.toThrow("PAPERCLIP_DECISION_SIGNING_SECRET must be at least 32 characters");
    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("passes the feedback export service into createApp so pending traces flush in runtime", async () => {
    const started = await startServer();

    expect(started.server).toBe(fakeServer);
    expect(feedbackServiceFactoryMock).toHaveBeenCalledTimes(1);
    expect(createAppMock).toHaveBeenCalledTimes(1);
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      feedbackExportService: feedbackExportServiceMock,
      storageService: { id: "storage-service" },
      serverPort: 3210,
    });
  });

  it("acquires and releases the cross-server lease around a manual backup", async () => {
    const migrationUrl = "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip-direct";
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseMigrationUrl: migrationUrl,
      databaseBackupSingletonEnabled: true,
    }));
    await startServer();

    const appOptions = createAppMock.mock.calls[0]?.[1] as {
      databaseBackupService: { runManualBackup(): Promise<unknown> };
    };
    await appOptions.databaseBackupService.runManualBackup();

    expect(tryAcquireDatabaseBackupLeaseMock).toHaveBeenCalledWith(migrationUrl);
    expect(runDatabaseBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: migrationUrl }),
    );
    expect(databaseBackupLeaseReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("cancels and joins a running backup before releasing its execution fence", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupSingletonEnabled: true,
    }));
    let resolveLeaseLost!: () => void;
    const leaseLost = new Promise<void>((resolve) => {
      resolveLeaseLost = resolve;
    });
    let held = true;
    const release = vi.fn(async () => {
      held = false;
    });
    tryAcquireDatabaseBackupLeaseMock.mockResolvedValueOnce({
      lost: leaseLost,
      isHeld: () => held,
      release,
    });
    let backupSignal: AbortSignal | null = null;
    runDatabaseBackupMock.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
      backupSignal = options.signal ?? null;
      if (!backupSignal) {
        return new Promise(() => {});
      }
      return new Promise((_, reject) => {
        backupSignal!.addEventListener(
          "abort",
          () => reject(new Error("pg_dump cancelled after execution authority loss")),
          { once: true },
        );
      });
    });
    await startServer();
    const appOptions = createAppMock.mock.calls[0]?.[1] as {
      databaseBackupService: { runManualBackup(): Promise<unknown> };
    };

    const runningBackup = appOptions.databaseBackupService.runManualBackup();
    await vi.waitFor(() => {
      expect(backupSignal).not.toBeNull();
    });
    held = false;
    resolveLeaseLost();

    await expect(runningBackup).rejects.toThrow(
      "pg_dump cancelled after execution authority loss",
    );
    expect(backupSignal!.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects a manual backup when another server owns the lease", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupSingletonEnabled: true,
    }));
    tryAcquireDatabaseBackupLeaseMock.mockResolvedValueOnce(null);
    await startServer();

    const appOptions = createAppMock.mock.calls[0]?.[1] as {
      databaseBackupService: { runManualBackup(): Promise<unknown> };
    };
    await expect(appOptions.databaseBackupService.runManualBackup()).rejects.toThrow(
      "Database backup already in progress on another server",
    );

    expect(runDatabaseBackupMock).not.toHaveBeenCalled();
    expect(databaseBackupLeaseReleaseMock).not.toHaveBeenCalled();
  });

  it("elects one automatic-backup emitter and uses a separate execution lease", async () => {
    const migrationUrl = "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip-direct";
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupEnabled: true,
      databaseBackupSingletonEnabled: true,
      databaseMigrationUrl: migrationUrl,
      databaseBackupIntervalMinutes: 60,
    }));
    const intervalCallbacks: Array<{ callback: () => void; intervalMs: number }> = [];
    const timeoutCallbacks: Array<{ callback: () => void; delayMs: number }> = [];
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void, intervalMs: number) => {
        intervalCallbacks.push({ callback, intervalMs });
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback: () => void, delayMs: number) => {
        timeoutCallbacks.push({ callback, delayMs });
        return 2 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

    try {
      await startServer();

      expect(tryAcquireDatabaseBackupEmitterLeaseMock).toHaveBeenCalledWith(migrationUrl);
      expect(databaseBackupEmitterLeaseReleaseMock).not.toHaveBeenCalled();
      expect(intervalCallbacks.some(({ intervalMs }) => intervalMs === 60_000)).toBe(true);
      const backupTimer = timeoutCallbacks.find(({ delayMs }) => delayMs === 0);
      expect(backupTimer).toBeDefined();

      backupTimer!.callback();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(tryAcquireDatabaseBackupLeaseMock).toHaveBeenCalledWith(migrationUrl);
      expect(runDatabaseBackupMock).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(databaseBackupLeaseReleaseMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("retries a due automatic backup when the execution lease is contended", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupEnabled: true,
      databaseBackupSingletonEnabled: true,
      databaseBackupIntervalMinutes: 60,
    }));
    tryAcquireDatabaseBackupLeaseMock.mockResolvedValueOnce(null);
    const timeoutCallbacks: Array<{ callback: () => void; delayMs: number }> = [];
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((() => 1 as unknown as ReturnType<typeof setInterval>) as typeof setInterval);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((callback: () => void, delayMs: number) => {
        timeoutCallbacks.push({ callback, delayMs });
        return 2 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

    try {
      await startServer();

      const dueBackup = timeoutCallbacks.find(({ delayMs }) => delayMs === 0);
      expect(dueBackup).toBeDefined();
      dueBackup!.callback();

      await vi.waitFor(() => {
        expect(timeoutCallbacks.some(({ delayMs }) => delayMs === 60_000)).toBe(true);
      });
      expect(runDatabaseBackupMock).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("releases automatic-backup leadership when startup fails after election", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupEnabled: true,
      databaseBackupSingletonEnabled: true,
      databaseBackupIntervalMinutes: 60,
    }));
    fakeServer.listen.mockImplementationOnce(() => {
      throw new Error("listen failed after backup election");
    });

    await expect(startServer()).rejects.toThrow("listen failed after backup election");

    expect(tryAcquireDatabaseBackupEmitterLeaseMock).toHaveBeenCalledTimes(1);
    expect(databaseBackupEmitterLeaseReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("keeps singleton authority default-off during a mixed-version rollout", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupEnabled: true,
      databaseBackupSingletonEnabled: false,
      databaseBackupIntervalMinutes: 60,
    }));
    const intervals: Array<{ callback: () => void; intervalMs: number }> = [];
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void, intervalMs: number) => {
        intervals.push({ callback, intervalMs });
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    try {
      await startServer();

      expect(tryAcquireDatabaseBackupEmitterLeaseMock).not.toHaveBeenCalled();
      const legacyBackupTimer = intervals.find(({ intervalMs }) => intervalMs === 3_600_000);
      expect(legacyBackupTimer).toBeDefined();
      legacyBackupTimer?.callback();
      await vi.waitFor(() => {
        expect(runDatabaseBackupMock).toHaveBeenCalledTimes(1);
      });
      expect(tryAcquireDatabaseBackupLeaseMock).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("aborts and joins a manual backup before a stalled shutdown notification", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseBackupSingletonEnabled: true,
    }));
    const events: string[] = [];
    let backupSignal: AbortSignal | null = null;
    databaseBackupLeaseReleaseMock.mockImplementationOnce(async () => {
      events.push("lease-released");
    });
    runDatabaseBackupMock.mockImplementationOnce(async (options: { signal?: AbortSignal }) => {
      backupSignal = options.signal ?? null;
      return new Promise((_, reject) => {
        backupSignal?.addEventListener(
          "abort",
          () => {
            events.push("backup-aborted");
            reject(new Error("manual backup cancelled during shutdown"));
          },
          { once: true },
        );
      });
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      events.push("process-exit");
      return undefined as never;
    }) as typeof process.exit);
    let resolveStoppingNotification: ((notified: boolean) => void) | null = null;

    try {
      await startServer();
      const appOptions = createAppMock.mock.calls[0]?.[1] as {
        databaseBackupService: { runManualBackup(): Promise<unknown> };
      };
      const runningBackup = appOptions.databaseBackupService.runManualBackup();
      const observedBackupFailure = runningBackup.catch((error: unknown) => error);
      await vi.waitFor(() => {
        expect(backupSignal).not.toBeNull();
      });

      systemdNotifyMock.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => {
          resolveStoppingNotification = resolve;
        }),
      );
      process.emit("SIGTERM");
      await vi.waitFor(() => {
        expect(backupSignal!.aborted).toBe(true);
        expect(databaseBackupLeaseReleaseMock).toHaveBeenCalledTimes(1);
      });
      expect(exitSpy).not.toHaveBeenCalled();
      await expect(observedBackupFailure).resolves.toMatchObject({
        message: "manual backup cancelled during shutdown",
      });
      expect(events.indexOf("backup-aborted")).toBeLessThan(events.indexOf("lease-released"));
      resolveStoppingNotification?.(false);
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
      });
      expect(events.indexOf("lease-released")).toBeLessThan(events.indexOf("process-exit"));
    } finally {
      resolveStoppingNotification?.(false);
      exitSpy.mockRestore();
    }
  });

  it("keeps routine ticks and setup cleanup active when heartbeat scheduling is suppressed", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: true,
      reason: "worktree_instance",
    });
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void) => {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    try {
      await startServer();

      expect(heartbeatServiceMock.reapOrphanedRuns).not.toHaveBeenCalled();
      expect(heartbeatServiceMock.tickTimers).not.toHaveBeenCalled();
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(1);

      expect(intervalCallback).not.toBeNull();
      intervalCallback?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(heartbeatServiceMock.tickTimers).not.toHaveBeenCalled();
      expect(externalObjectsServiceMock.refreshDueObjectsForActiveCompanies).toHaveBeenCalledTimes(1);
      expect(issueThreadInteractionServiceMock.sweepMergedPullRequestConfirmations).toHaveBeenCalledTimes(1);
      expect(executionWorkspaceServiceMock.sweepTerminalWorkspaces).toHaveBeenCalledTimes(1);
      expect(routineServiceMock.tickScheduledTriggers).toHaveBeenCalledTimes(1);
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(2);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("keeps external object refresh active when heartbeat scheduling is disabled", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void) => {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);

    try {
      await startServer();

      expect(heartbeatServiceFactoryMock).not.toHaveBeenCalled();
      expect(intervalCallback).not.toBeNull();
      intervalCallback?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(externalObjectsServiceMock.refreshDueObjectsForActiveCompanies).toHaveBeenCalledTimes(1);
      expect(routineServiceMock.tickScheduledTriggers).not.toHaveBeenCalled();
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does not replay hot-restart adoption when the orphan reaper retries", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    heartbeatServiceMock.reconcileHotRestartAdoption.mockRejectedValueOnce(new Error("partial adoption"));
    heartbeatServiceMock.reapOrphanedRuns
      .mockRejectedValueOnce(new Error("transient reap failure"))
      .mockResolvedValueOnce({ reaped: 0, runIds: [] });

    await startServer();

    expect(heartbeatServiceMock.reconcileHotRestartAdoption).toHaveBeenCalledTimes(1);
    expect(heartbeatServiceMock.reapOrphanedRuns).toHaveBeenCalledTimes(2);
  });

  it("refuses authenticated public startup without an external database URL", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://tenant.example.com",
      databaseMode: "embedded-postgres",
      databaseUrl: undefined,
    }));

    await expect(startServer()).rejects.toThrow(
      "authenticated public deployments require DATABASE_URL or config.database.connectionString",
    );
    expect(createDbMock).not.toHaveBeenCalled();
  });

  it("refuses authenticated public startup when DATABASE_URL is not a postgres URL", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://tenant.example.com",
      databaseUrl: "secret://paperclip-cloud/stacks/alpha/database/runtime-url",
    }));

    await expect(startServer()).rejects.toThrow(
      "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
    );
    expect(createDbMock).not.toHaveBeenCalled();
  });
});

describe("startServer authenticated auth origin setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("derives trusted origins from the detected listen port before auth initializes", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      port: 3210,
      allowedHostnames: ["board.example.test"],
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://127.0.0.1:3210",
    }));
    detectPortMock.mockResolvedValueOnce(3211);
    deriveAuthTrustedOriginsMock.mockImplementation(
      (_config: { port: number; authPublicBaseUrl?: string }, opts?: { listenPort?: number }) => [
        `http://board.example.test:${opts?.listenPort ?? 0}`,
      ],
    );

    await startServer();

    expect(deriveAuthTrustedOriginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "http://127.0.0.1:3211/",
      }),
      { listenPort: 3211 },
    );
    expect(createBetterAuthInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "http://127.0.0.1:3211/",
      }),
      ["http://board.example.test:3211"],
    );
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      serverPort: 3211,
    });
  });
});

describe("startServer PAPERCLIP_API_URL handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    loadConfigMock.mockReturnValue(buildTestConfig());
    process.env.BETTER_AUTH_SECRET = "test-secret";
    delete process.env.PAPERCLIP_API_URL;
  });

  afterEach(() => {
    if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

    if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

    if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) {
      delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    } else {
      process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    }

    if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
    else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

    if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
    else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;
  });

  it("uses the externally set PAPERCLIP_API_URL when provided", async () => {
    process.env.PAPERCLIP_API_URL = "http://custom-api:3100";

    const started = await startServer();

    expect(started.apiUrl).toBe("http://custom-api:3100");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://custom-api:3100");
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")).toEqual(
      expect.arrayContaining(["http://custom-api:3100"]),
    );
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")[0]).toBe("http://custom-api:3100");
  });

  it("falls back to host-based URL when PAPERCLIP_API_URL is not set", async () => {
    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("keeps loopback as the runtime API URL when allowed hostnames are present", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      allowedHostnames: ["192.168.1.50"],
    }));

    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:3210");
    expect(JSON.parse(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? "[]")).toEqual(
      expect.arrayContaining(["http://127.0.0.1:3210", "http://192.168.1.50:3210"]),
    );
  });

  it("rewrites explicit-port auth public URLs when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      port: 3100,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://my-host.ts.net:3100",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("http://my-host.ts.net:3110");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://my-host.ts.net:3110");
  });

  it("keeps no-port auth public URLs stable when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      port: 3100,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://paperclip.example",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("https://paperclip.example");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("https://paperclip.example");
  });
});
