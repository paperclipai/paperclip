import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAppMock,
  createDbMock,
  detectPortMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
  fakeServer,
} = vi.hoisted(() => {
  const createAppMock = vi.fn(async () => ((_: unknown, __: unknown) => {}) as never);
  const createDbMock = vi.fn(() => ({}) as never);
  const detectPortMock = vi.fn(async (port: number) => port);
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

  return {
    createAppMock,
    createDbMock,
    detectPortMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
    fakeServer,
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
  loadConfig: vi.fn(() => ({
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
    companyDeletionEnabled: false,
  })),
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
  accessService: () => ({ canUser: vi.fn(async () => true), canAgent: vi.fn(async () => true) }),
  agentService: () => ({ findById: vi.fn(async () => null), findByCompany: vi.fn(async () => []), update: vi.fn(async (id: string, data: any) => ({ id, ...data })) }),
  executionWorkspaceService: () => ({ findById: vi.fn(async () => null) }),
  goalService: () => ({ findById: vi.fn(async () => null) }),
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  issueApprovalService: () => ({ findById: vi.fn(async () => null) }),
  issueService: () => ({ findById: vi.fn(async () => null), update: vi.fn(async (id: string, data: any) => ({ id, ...data })), countRecentByAgent: vi.fn(async () => 0) }),
  documentService: () => ({ findByIssueAndKey: vi.fn(async () => null) }),
  logActivity: vi.fn(async () => {}),
  projectService: () => ({ findById: vi.fn(async () => null) }),
  workProductService: () => ({ findByIssue: vi.fn(async () => []) }),
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
});
