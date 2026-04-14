import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAppMock,
  createDbMock,
  detectPortMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  createFeedbackTraceShareClientFromConfigMock,
  issueServiceFactoryMock,
  archiveClosedAcrossCompaniesMock,
  fakeServer,
  loadConfigMock,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createDbMock = vi.fn(() => ({}) as never);
  const detectPortMock = vi.fn(async (port: number) => port);
  const archiveClosedAcrossCompaniesMock = vi.fn(async () => ({
    archivedCount: 0,
    olderThanDays: 14,
    archivedAt: new Date("2026-04-12T00:00:00.000Z"),
    cutoff: new Date("2026-03-29T00:00:00.000Z"),
    byCompany: [],
  }));
  const issueServiceFactoryMock = vi.fn(() => ({
    archiveClosedAcrossCompanies: archiveClosedAcrossCompaniesMock,
  }));
  const loadConfigMock = vi.fn(() => ({
    deploymentMode: "authenticated",
    deploymentExposure: "private",
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
    closedIssueArchiveEnabled: false,
    closedIssueArchiveIntervalMs: 3600000,
    closedIssueArchiveAgeDays: 14,
    companyDeletionEnabled: false,
    telemetryEnabled: true,
  }));
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const createFeedbackTraceShareClientFromConfigMock = vi.fn(() => ({ id: "feedback-share-client" }));
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };

  return {
    createAppMock,
    createDbMock,
    detectPortMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    createFeedbackTraceShareClientFromConfigMock,
    issueServiceFactoryMock,
    archiveClosedAcrossCompaniesMock,
    fakeServer,
    loadConfigMock,
  };
});

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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  feedbackService: feedbackServiceFactoryMock,
  heartbeatService: vi.fn(() => ({
    reapOrphanedRuns: vi.fn(async () => undefined),
    resumeQueuedRuns: vi.fn(async () => undefined),
    tickTimers: vi.fn(async () => ({ enqueued: 0 })),
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  routineService: vi.fn(() => ({
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  })),
  issueService: issueServiceFactoryMock,
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: createFeedbackTraceShareClientFromConfigMock,
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
  createBetterAuthInstance: vi.fn(() => ({})),
  deriveAuthTrustedOrigins: vi.fn(() => []),
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BETTER_AUTH_SECRET = "test-secret";
    loadConfigMock.mockImplementation(() => ({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
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
      closedIssueArchiveEnabled: false,
      closedIssueArchiveIntervalMs: 3600000,
      closedIssueArchiveAgeDays: 14,
      companyDeletionEnabled: false,
      telemetryEnabled: true,
    }));
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
    expect(feedbackServiceFactoryMock.mock.calls[0]?.[1]).toMatchObject({
      shareClient: { id: "feedback-share-client" },
    });
  }, 15_000);

  it("keeps feedback export opt-in by omitting the share client when no backend url is configured", async () => {
    loadConfigMock.mockImplementation(() => ({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
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
      feedbackExportBackendUrl: undefined,
      feedbackExportBackendToken: undefined,
      heartbeatSchedulerEnabled: false,
      heartbeatSchedulerIntervalMs: 30000,
      closedIssueArchiveEnabled: false,
      closedIssueArchiveIntervalMs: 3600000,
      closedIssueArchiveAgeDays: 14,
      companyDeletionEnabled: false,
      telemetryEnabled: true,
    }));

    await startServer();

    expect(createFeedbackTraceShareClientFromConfigMock).not.toHaveBeenCalled();
    expect(feedbackServiceFactoryMock.mock.calls[0]?.[1]).toMatchObject({
      shareClient: undefined,
    });
  });

  it("does not initialize closed issue auto-archive scheduler when disabled", async () => {
    await startServer();

    expect(issueServiceFactoryMock).not.toHaveBeenCalled();
  });

  it("initializes closed issue auto-archive scheduler when enabled and runs configured threshold", async () => {
    loadConfigMock.mockImplementation(() => ({
      deploymentMode: "authenticated",
      deploymentExposure: "private",
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
      closedIssueArchiveEnabled: true,
      closedIssueArchiveIntervalMs: 60000,
      closedIssueArchiveAgeDays: 21,
      companyDeletionEnabled: false,
      telemetryEnabled: true,
    }));

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue({} as ReturnType<typeof setInterval>);

    await startServer();

    expect(issueServiceFactoryMock).toHaveBeenCalledTimes(1);
    const archiveScheduler = setIntervalSpy.mock.calls.find((call) => call[1] === 60000);
    expect(archiveScheduler).toBeDefined();

    const tick = archiveScheduler?.[0] as (() => void) | undefined;
    tick?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(archiveClosedAcrossCompaniesMock).toHaveBeenCalledWith({ olderThanDays: 21 });

    setIntervalSpy.mockRestore();
  });
});
