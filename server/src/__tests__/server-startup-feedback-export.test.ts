import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const primaryRuntimeControls = {
  role: "primary",
  heartbeatSchedulerEnabled: false,
  routineSchedulerEnabled: false,
  pluginSchedulerEnabled: true,
  pluginWorkersEnabled: true,
  pluginAutoInstallEnabled: true,
  startupRecoveryEnabled: false,
  startupReconciliationEnabled: true,
  databaseBackupSchedulerEnabled: false,
  feedbackExporterEnabled: true,
  migrationsApplyAllowed: true,
  migrationMode: "apply",
  disabledSystems: [],
};

const passiveRuntimeControls = {
  role: "staged",
  heartbeatSchedulerEnabled: false,
  routineSchedulerEnabled: false,
  pluginSchedulerEnabled: false,
  pluginWorkersEnabled: false,
  pluginAutoInstallEnabled: false,
  startupRecoveryEnabled: false,
  startupReconciliationEnabled: false,
  databaseBackupSchedulerEnabled: false,
  feedbackExporterEnabled: false,
  migrationsApplyAllowed: false,
  migrationMode: "refuse",
  disabledSystems: [],
};

const {
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  detectPortMock,
  deriveAuthTrustedOriginsMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
  applyPendingMigrationsMock,
  backfillPrincipalAccessCompatibilityMock,
  bootstrapExecutionPolicyFromEnvMock,
  heartbeatServiceMock,
  loadConfigMock,
  inspectMigrationsMock,
  reconcileCloudUpstreamRunsOnStartupMock,
  reconcilePersistedRuntimeServicesOnStartupMock,
  routineServiceMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({}) as never);
  const detectPortMock = vi.fn(async (port: number) => port);
  const deriveAuthTrustedOriginsMock = vi.fn(() => []);
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
  const inspectMigrationsMock = vi.fn(async () => ({ status: "upToDate" }));
  const applyPendingMigrationsMock = vi.fn();
  const backfillPrincipalAccessCompatibilityMock = vi.fn(async () => ({
    agentMembershipsInserted: 0,
    humanGrantsInserted: 0,
  }));
  const bootstrapExecutionPolicyFromEnvMock = vi.fn(async () => null);
  const heartbeatServiceMock = vi.fn(() => ({
    reapOrphanedRuns: vi.fn(async () => undefined),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [],
    })),
    reconcileIssueGraphLiveness: vi.fn(async () => ({ escalationsCreated: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    reconcileProductivityReviews: vi.fn(async () => ({ created: 0, updated: 0, failed: 0 })),
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
  }));
  const routineServiceMock = vi.fn(() => ({
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  }));
  const reconcileCloudUpstreamRunsOnStartupMock = vi.fn(async () => ({ reconciled: 0 }));
  const reconcilePersistedRuntimeServicesOnStartupMock = vi.fn(async () => ({ reconciled: 0 }));
  const loadConfigMock = vi.fn();

  return {
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    detectPortMock,
    deriveAuthTrustedOriginsMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
    applyPendingMigrationsMock,
    backfillPrincipalAccessCompatibilityMock,
    bootstrapExecutionPolicyFromEnvMock,
    heartbeatServiceMock,
    loadConfigMock,
    inspectMigrationsMock,
    reconcileCloudUpstreamRunsOnStartupMock,
    reconcilePersistedRuntimeServicesOnStartupMock,
    routineServiceMock,
  };
});

function buildTestConfig(overrides: Record<string, unknown> = {}) {
  return {
    runtimeRole: "primary",
    runtimeControls: primaryRuntimeControls,
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
  inspectMigrations: inspectMigrationsMock,
  applyPendingMigrations: applyPendingMigrationsMock,
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
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
  backfillPrincipalAccessCompatibility: backfillPrincipalAccessCompatibilityMock,
  feedbackService: feedbackServiceFactoryMock,
  bootstrapExecutionPolicyFromEnv: bootstrapExecutionPolicyFromEnvMock,
  heartbeatService: heartbeatServiceMock,
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(async () => ({
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    })),
  })),
  reconcileCloudUpstreamRunsOnStartup: reconcileCloudUpstreamRunsOnStartupMock,
  reconcilePersistedRuntimeServicesOnStartup: reconcilePersistedRuntimeServicesOnStartupMock,
  routineService: routineServiceMock,
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
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

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectMigrationsMock.mockResolvedValue({ status: "upToDate" });
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "test-secret";
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

describe("startServer runtime role guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectMigrationsMock.mockResolvedValue({ status: "upToDate" });
    loadConfigMock.mockReturnValue(buildTestConfig());
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("passes runtime controls into createApp for health and plugin startup decisions", async () => {
    await startServer();

    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      runtimeControls: primaryRuntimeControls,
    });
  });

  it("does not call startup reconciliation, execution bootstrap, or heartbeat factories in staged", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      runtimeRole: "staged",
      runtimeControls: passiveRuntimeControls,
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
    }));

    await startServer();

    expect(backfillPrincipalAccessCompatibilityMock).not.toHaveBeenCalled();
    expect(reconcilePersistedRuntimeServicesOnStartupMock).not.toHaveBeenCalled();
    expect(reconcileCloudUpstreamRunsOnStartupMock).not.toHaveBeenCalled();
    expect(bootstrapExecutionPolicyFromEnvMock).not.toHaveBeenCalled();
    expect(heartbeatServiceMock).not.toHaveBeenCalled();
    expect(routineServiceMock).not.toHaveBeenCalled();
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      runtimeControls: passiveRuntimeControls,
    });
  });

  it("does not call startup reconciliation, execution bootstrap, or heartbeat factories in api-only", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      runtimeRole: "api-only",
      runtimeControls: { ...passiveRuntimeControls, role: "api-only" },
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
    }));

    await startServer();

    expect(backfillPrincipalAccessCompatibilityMock).not.toHaveBeenCalled();
    expect(reconcilePersistedRuntimeServicesOnStartupMock).not.toHaveBeenCalled();
    expect(reconcileCloudUpstreamRunsOnStartupMock).not.toHaveBeenCalled();
    expect(bootstrapExecutionPolicyFromEnvMock).not.toHaveBeenCalled();
    expect(heartbeatServiceMock).not.toHaveBeenCalled();
    expect(routineServiceMock).not.toHaveBeenCalled();
  });

  it("refuses pending migration apply in staged", async () => {
    inspectMigrationsMock.mockResolvedValue({
      status: "needsMigrations",
      reason: "pending-migrations",
      pendingMigrations: ["0002_runtime_role_test"],
    });
    loadConfigMock.mockReturnValue(buildTestConfig({
      runtimeRole: "staged",
      runtimeControls: passiveRuntimeControls,
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
    }));

    await expect(startServer()).rejects.toThrow(
      "PAPERCLIP_RUNTIME_ROLE=staged refuses migration apply",
    );
    expect(applyPendingMigrationsMock).not.toHaveBeenCalled();
    expect(createDbMock).not.toHaveBeenCalled();
  });
});

describe("startServer authenticated auth origin setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inspectMigrationsMock.mockResolvedValue({ status: "upToDate" });
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
    inspectMigrationsMock.mockResolvedValue({ status: "upToDate" });
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
