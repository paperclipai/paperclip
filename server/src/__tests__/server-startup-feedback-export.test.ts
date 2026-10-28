import { approvalQueueSeedingService } from "../services/approval-queue-seeding-work.js";
import { joinRequestRetentionService } from "../services/join-request-retention.js";
import { approvalRetentionService } from "../services/approval-retention.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { logger } from "../middleware/logger.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import * as idleLocalWork from "../services/idle-local-work.js";
import { idleBackupWakeMarker, markIdleBackupWakeRequired } from "../services/idle-database-backup.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { decisionService, decisionRetentionService, toolAccessService, reconcileBuiltInAgentsOnStartup, reconcileCodexLocalManagedHomesOnStartup, reconcilePersistedRuntimeServicesOnStartup } from "../services/index.js";

import { companies, runDatabaseBackup, type Db } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  caseHandoffDeliveryServiceFactoryMock,
  caseHandoffDeliveryServiceMock,
  completionSweepMock,
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  detectPortMock,
  deriveAuthTrustedOriginsMock,
  deliveryWorkRegisterMock,
  deliveryWorkErrors,
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
  routineServiceFactoryMock,
  routineServiceMock,
} = vi.hoisted(() => {
  const caseHandoffDeliveryServiceMock = {
    hasPending: vi.fn(async () => false),
    sweepPending: vi.fn(async (_signal?: AbortSignal) => undefined),
  };
  const caseHandoffDeliveryServiceFactoryMock = vi.fn(() => caseHandoffDeliveryServiceMock);
  const completionSweepMock = vi.fn(async () => undefined);
  const deliveryWorkErrors: Array<{ queue: string; error: unknown }> = [];
  const deliveryWorkRegisterMock = vi.fn((queue: string, task: {
    retryMs?: number;
    run: (signal?: AbortSignal) => Promise<unknown>;
    hasPending?: () => Promise<boolean>;
  }) => ({ ready: task.run(new AbortController().signal).catch(error => { deliveryWorkErrors.push({ queue, error }); }), wake: vi.fn() }));
  const createAppMock = vi.fn(async () => Object.assign((_: unknown, __: unknown) => {}, {
    locals: {
      fastResponses: { hasPending: vi.fn(async () => false), sweepPending: vi.fn(async () => undefined) },
      deliveryWork: {
        register: deliveryWorkRegisterMock,
        stop: vi.fn(async () => {}),
      },
      toolGateway: {
        settleInterruptedActionReviews: vi.fn(async () => ({ scanned: 0 })),
        nextActionReviewInterruptionAt: vi.fn(async () => null),
        recoverApprovedActionReviews: vi.fn(async () => ({ scanned: 0, retry: false })),
        repairActionReviewProjections: vi.fn(async () => ({ scanned: 0, retry: false })),
        actionReviewProjectionCompanies: vi.fn(async () => []),
        approvedActionReviewCompanies: vi.fn(async () => []),
        sweepActionReviews: vi.fn(async () => ({ scanned: 0 })),
        sweepExpiredActionReviews: vi.fn(async () => ({ scanned: 0 })),
        nextActionReviewExpiryAt: vi.fn(async () => null),
        actionReviewExpiryDeadlines: vi.fn(async () => []),
        sweepExpiredActionReviewsForCompany: vi.fn(async () => ({ scanned: 0 })),
        cleanupExpiredSessions: vi.fn(async () => ({ deletedCount: 0 })),
        nextCredentialExpiryAt: vi.fn(async () => null),
      },
      toolActionDeliveries: { hasPending: vi.fn(async () => false), sweepPending: vi.fn(async () => ({ scanned: 0, delivered: 0 })) },
    },
  }) as never);
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
  }) as never);
  const detectPortMock = vi.fn(async ({ port }: { port: number; hostname: string }) => port);
  const deriveAuthTrustedOriginsMock = vi.fn(() => []);
  const resolveHeartbeatSchedulingSuppressionMock = vi.fn(() => ({
    suppressed: false,
    reason: null,
  }));
  const heartbeatServiceMock = {
    reconcileCostAccounting: vi.fn(async () => ({ scanned: 0, accounted: 0 })),
    resolveSchedulingSuppression: resolveHeartbeatSchedulingSuppressionMock,
    recoverNativeRunsAfterRestart: vi.fn(async () => ({
      restartKind: "hard",
      dispositions: [],
      claims: [],
      awaitingEvidenceRunIds: [],
      blockedRunIds: [],
    })),
    reconcileHotRestartAdoption: vi.fn(async () => ({ mode: "none" })),
    reapOrphanedRuns: vi.fn(async () => ({ reaped: 0, runIds: [] })),
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    recoverPendingSessionGoalActions: vi.fn(async () => ({ scanned: 0, enqueued: 0, alreadyQueued: 0, invalid: 0 })),
    recoverActiveSessionGoals: vi.fn(async () => ({ scanned: 0, enqueued: 0 })),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      escalated: 0,
      skipped: 0,
      issueIds: [],
    })),
    reconcileResolvedDependencyWakes: vi.fn(async () => ({ healed: 0 })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
    sweepPendingCleanupLeases: vi.fn(async () => ({ swept: 0, destroyed: 0, capped: 0 })),
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
    nextSetupCleanupAt: vi.fn(async (): Promise<number | null> => null),
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
  const feedbackExportServiceMock = {
    hasPendingFeedbackTraces: vi.fn(async () => false),
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
  const fakeServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
  };
  const loadConfigMock = vi.fn();

  return {
    caseHandoffDeliveryServiceFactoryMock,
    caseHandoffDeliveryServiceMock,
    completionSweepMock,
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    detectPortMock,
    deriveAuthTrustedOriginsMock,
    deliveryWorkRegisterMock,
    deliveryWorkErrors,
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
    routineServiceFactoryMock,
    routineServiceMock,
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

vi.mock("@paperclipai/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/db")>(),
  createDb: createDbMock,
  ensurePostgresDatabase: vi.fn(),
  getPostgresDataDirectory: vi.fn(),
  inspectMigrations: vi.fn(async () => ({ status: "upToDate" })),
  applyPendingMigrations: vi.fn(),
  reconcilePendingMigrationHistory: vi.fn(async () => ({ repairedMigrations: [] })),
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  closeLivenessDb: vi.fn(async () => {}),
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

// Startup owns registration. Durable budget/accounting state and coordinator
// retry delivery are exercised against PostgreSQL in the worker suites.
vi.mock("../services/budgets.js", () => ({
  deliverBudgetEnforcement: vi.fn(async () => undefined),
  hasPendingBudgetEnforcement: vi.fn(async () => false),
  nextBudgetReconciliationAt: vi.fn(async () => null),
  reconcileDueBudgetPolicies: vi.fn(async () => ({ nextCursor: null })),
}));
vi.mock("../services/run-cost-accounting.js", () => ({
  readCostAccountingWork: vi.fn(async () => ({ pending: false, nextRunAt: null })),
}));

// This suite exercises startup coordination; source persistence and authority
// are covered by the database-backed source worker tests.
vi.mock("../services/skill-source-sync.js", () => ({
  skillSourceSyncService: () => ({ start: vi.fn(), stop: vi.fn(async () => {}) }),
}));

vi.mock("../services/native-runtime/native-session-executor.js", () => ({
  verifyStoppedNativeSessionForReplacement: vi.fn(async () => null),
}));

// This suite verifies server startup scheduling; replacement correctness is
// exercised by the dedicated DB-backed recovery suites.
vi.mock("../services/native-runtime/native-safe-replacement.js", () => ({
  reconcileSafeNativeReplacements: vi.fn(async () => ({ scanned: 0, scheduled: 0 })),
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

vi.mock("../services/join-request-retention.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/join-request-retention.js")>(),
  joinRequestRetentionService: vi.fn(() => ({ sweep: vi.fn(async () => ({ archived: 0 })), next: vi.fn(async () => null) })),
}));

vi.mock("../services/approval-queue-seeding-work.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/approval-queue-seeding-work.js")>(),
  approvalQueueSeedingService: vi.fn(() => ({ sweep: vi.fn(async () => undefined), next: vi.fn(() => null), request: vi.fn() })),
}));

vi.mock("../services/approval-retention.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/approval-retention.js")>(),
  approvalRetentionService: vi.fn(() => ({ sweep: vi.fn(async () => ({ archived: 0 })), next: vi.fn(async () => null) })),
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
    sweepInvalidTargets: vi.fn(async () => ({ expired: 0 })),
    decisionTargetsChanged: vi.fn(),
    hasDecisionTargetWork: vi.fn(() => false),
    recoverEffects: vi.fn(async () => ({ resumed: 0 })),
    nextEffectRecoveryAt: vi.fn(async () => null),
    sweepTtlExpiry: vi.fn(async () => ({ expired: 0 })),
    nextExpiryAt: vi.fn(async () => null),
    sweepContinuations: vi.fn(async () => ({ retry: false })),
  })),
  decisionRetentionService: vi.fn(() => ({
    autoArchive: vi.fn(async () => 0),
    deliverNotifications: vi.fn(async () => ({ notifiedAgents: 0, delivered: 0 })),
    nextArchiveNotificationAt: vi.fn(async () => null),
  })),
  feedbackService: feedbackServiceFactoryMock,
  bootstrapExecutionPolicyFromEnv: vi.fn(async () => null),
  applyManagedEnvironments: vi.fn(async () => null),
  environmentCustomImageService: environmentCustomImagesServiceFactoryMock,
  executionWorkspaceService: executionWorkspaceServiceFactoryMock,
  externalObjectService: externalObjectsServiceFactoryMock,
  heartbeatService: heartbeatServiceFactoryMock,
  githubConnectionEventService: vi.fn(() => ({
    pollOnce: vi.fn(async () => ({
      leased: 0,
      processed: 0,
      duplicate: 0,
      ignored: 0,
      failed: 0,
    })),
  })),
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
    scheduledHealth: { load: vi.fn(async () => []), check: vi.fn(async () => null) },
    sweepConnectionHealth: vi.fn(async () => ({
      checked: 0,
      healthy: 0,
      needsAttention: 0,
      failed: 0,
    })),
    sweepGitHubConnectionContinuity: vi.fn(async () => ({
      checked: 0,
      due: 0,
      refreshed: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/chat-completion-delivery.js", () => ({ chatCompletionDeliveryService: () => ({ hasPending: vi.fn(async () => false), sweepPending: completionSweepMock }) }));

// Only startup registration belongs here; real handoff persistence, authority,
// and provider settlement are covered by the database-backed workflow suites.
vi.mock("../services/case-handoff-delivery.js", () => ({
  caseHandoffDeliveryService: caseHandoffDeliveryServiceFactoryMock,
}));

vi.mock("../services/connection-intent-delivery.js", () => ({
  connectionIntentDeliveryService: vi.fn(() => ({
    hasPending: vi.fn(async () => false),
    sweepPending: vi.fn(async () => ({ scanned: 0, failed: 0 })),
  })),
}));

vi.mock("../services/question-response-delivery.js", () => ({
  questionResponseDeliveryService: vi.fn(() => ({
    hasPending: vi.fn(async () => false),
    sweepPending: vi.fn(async () => ({
      scanned: 0,
      steered: 0,
      coalesced: 0,
      wakeFallback: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../services/native-runtime/native-question-bridge.js", () => ({
  deliverNativeQuestionResponse: vi.fn(async () => "not_native"),
  nativeQuestionCancellationIdentity: vi.fn(() => null),
  nativeQuestionRunToCancel: vi.fn(async () => null),
  validateNativeQuestionResponseInput: vi.fn(),
}));

vi.mock("../services/secret-proposals.js", () => ({
  createSecretProposalsService: vi.fn(() => ({
    expiryDeadlines: vi.fn(async () => []),
    sweepExpiredForCompany: vi.fn(async () => 0),
    nextExpiryAt: vi.fn(async () => null),
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
import { reconcileSafeNativeReplacements } from "../services/native-runtime/native-safe-replacement.js";
import { EXECUTION_RECONCILIATION_INTERVAL_MS } from "../services/execution-control-deadline.js";

// Startup housekeeping runs after readiness and starts the heartbeat scheduler
// interval when it finishes. Let that background work settle.
async function settleStartupHousekeeping() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveryWorkErrors.length = 0;
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "fedcba9876543210fedcba9876543210";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "0123456789abcdef0123456789abcdef";
    loadConfigMock.mockReturnValue(buildTestConfig());
    resolveHeartbeatSchedulingSuppressionMock.mockReturnValue({
      suppressed: false,
      reason: null,
    });
    createBetterAuthInstanceMock.mockReturnValue({});
    deriveAuthTrustedOriginsMock.mockReturnValue([]);
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it.each([false, true])("registers approval queue seeding only when maintenance is enabled (%s)", async enabled => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: enabled }));
    await startServer(); await settleStartupHousekeeping();
    const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.approvalQueueSeeding);
    expect(Boolean(registration)).toBe(enabled);
    if (enabled) {
      const service = vi.mocked(approvalQueueSeedingService).mock.results.at(-1)!.value;
      await registration![1].run(new AbortController().signal);
      expect(service.sweep).toHaveBeenCalled();
      expect(registration![1].nextRunAt()).toBeNull();
      expect(await registration![1].hasPending()).toBe(false);
      expect(service.next).toHaveBeenCalled();
    }
  });

  it.each([false, true])("registers approval retention only when maintenance is enabled (%s)", async enabled => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: enabled }));
    await startServer(); await settleStartupHousekeeping();
    const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.approvalRetention);
    expect(Boolean(registration)).toBe(enabled);
    if (enabled) {
      const service = vi.mocked(approvalRetentionService).mock.results.at(-1)!.value;
      await registration![1].run(new AbortController().signal);
      expect(service.sweep).toHaveBeenCalled(); expect(service.next).toHaveBeenCalled();
    }
  });

  it.each([false, true])("registers join request retention only when maintenance is enabled (%s)", async enabled => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: enabled }));
    await startServer(); await settleStartupHousekeeping();
    const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.joinRequestRetention);
    expect(Boolean(registration)).toBe(enabled);
    if (enabled) {
      const service = vi.mocked(joinRequestRetentionService).mock.results.at(-1)!.value;
      await registration![1].run(new AbortController().signal);
      expect(service.sweep).toHaveBeenCalled(); expect(service.next).toHaveBeenCalled();
    }
  });

  it.each([false, true])("registers archive delivery separately from retention sweeps (scheduler %s)", async enabled => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: enabled, heartbeatSchedulerIntervalMs: 30000 }));
    let tick: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, interval: number) => {
      if (interval === 30000) tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      await startServer(); await settleStartupHousekeeping();
      const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.decisionArchiveDelivery);
      if (!enabled) {
        expect(registration).toBeUndefined();
        expect(decisionRetentionService).not.toHaveBeenCalled();
        expect(tick).toBeDefined(); tick!(); await settleStartupHousekeeping();
        expect(decisionRetentionService).not.toHaveBeenCalled();
        return;
      }
      expect(registration).toBeDefined();
      const retention = vi.mocked(decisionRetentionService).mock.results[0]!.value;
      expect(retention.deliverNotifications).toHaveBeenCalledOnce();
      expect(retention.nextArchiveNotificationAt).toHaveBeenCalledOnce();
      const db = createDbMock.mock.results[0]!.value as Db;
      const companyReads = () => vi.mocked(db.select).mock.results.filter(({ value }) =>
        vi.mocked(value.from).mock.calls.some(([table]) => table === companies)).length;
      const before = companyReads();
      expect(before).toBeGreaterThan(0); expect(tick).toBeDefined();
      tick!(); await settleStartupHousekeeping();
      expect(companyReads()).toBeGreaterThan(before);
      expect(retention.deliverNotifications).toHaveBeenCalledOnce();
      await registration![1].run(new AbortController().signal);
      expect(retention.deliverNotifications).toHaveBeenCalledTimes(2);
    } finally { timer.mockRestore(); }
  });

  it("registers durable case handoffs independently of the heartbeat scheduler", async () => {
    await startServer();
    expect(caseHandoffDeliveryServiceFactoryMock).toHaveBeenCalledWith(createDbMock.mock.results[0]!.value, { heartbeat: heartbeatServiceMock });
    const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.caseHandoffs);
    expect(registration).toBeDefined();
    expect(registration![1]).toMatchObject({ retryMs: 5_000 });
    const controller = new AbortController();
    await registration![1].run(controller.signal);
    expect(caseHandoffDeliveryServiceMock.sweepPending).toHaveBeenLastCalledWith(controller.signal);
    await registration![1].hasPending!();
    expect(caseHandoffDeliveryServiceMock.hasPending).toHaveBeenCalledOnce();
  });

  it.each([false, true].flatMap(checkpointMode => [false, true].map(fails => ({ checkpointMode, fails }))))
  ("finishes restart backup before idle eligibility (checkpoint=$checkpointMode, failure=$fails)", async ({ checkpointMode, fails }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "startup-idle-backup-"));
    const previousFlag = process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED;
    process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED = checkpointMode ? "1" : "0";
    loadConfigMock.mockReturnValue(buildTestConfig({ databaseBackupEnabled: true, databaseBackupDir: directory }));
    const eligible = vi.spyOn(idleLocalWork, "markIdleStartupComplete");
    let retry: (() => void) | undefined;
    const timers = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 60 * 60 * 1000) retry = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const writeBackup = async (options: Parameters<typeof runDatabaseBackup>[0]) => {
      const backupFile = path.join(directory, "paperclip-restart.sql.gz");
      const bytes = gzipSync("SELECT 'restart recovery';\n");
      writeFileSync(backupFile, bytes);
      expect(options.retention).toEqual({ dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 });
      expect(options.verifyBeforePrune).toEqual(expect.any(Function));
      await options.verifyBeforePrune!(backupFile);
      return { backupFile, sizeBytes: bytes.length, prunedCount: 0 };
    };
    vi.mocked(runDatabaseBackup).mockImplementationOnce(async options => {
      await pending;
      if (fails) throw new Error("fixture restart backup failed");
      return writeBackup(options);
    });
    let starting: ReturnType<typeof startServer> | undefined;
    try {
      await markIdleBackupWakeRequired(directory);
      starting = startServer();
      await vi.waitFor(() => expect(runDatabaseBackup).toHaveBeenCalledOnce());
      expect(eligible).not.toHaveBeenCalled();
      expect(idleWorkSnapshot().active).toBeGreaterThan(0);
      finish();
      await starting;
      expect(eligible).toHaveBeenCalledWith({ scheduledBackups: true });
      const options = createAppMock.mock.calls[0]?.[1] as unknown as { prepareIdleDatabaseBackup?: unknown };
      expect(Boolean(options.prepareIdleDatabaseBackup)).toBe(checkpointMode);
      expect(existsSync(idleBackupWakeMarker(directory))).toBe(fails);
      if (fails) {
        vi.mocked(runDatabaseBackup).mockImplementationOnce(writeBackup);
        expect(retry).toEqual(expect.any(Function));
        const activeBeforeRetry = idleWorkSnapshot().active;
        retry!();
        await vi.waitFor(() => {
          expect(existsSync(idleBackupWakeMarker(directory))).toBe(false);
          // Marker removal precedes directory fsync and release of the work receipt.
          expect(idleWorkSnapshot().active).toBe(activeBeforeRetry);
        });
        expect(runDatabaseBackup).toHaveBeenCalledTimes(2);
      }
    } finally {
      finish();
      await starting;
      timers.mockRestore(); eligible.mockRestore();
      if (previousFlag === undefined) delete process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED;
      else process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED = previousFlag;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(([
    ["built-in agents", reconcileBuiltInAgentsOnStartup],
    ["managed homes", reconcileCodexLocalManagedHomesOnStartup],
    ["runtime services", reconcilePersistedRuntimeServicesOnStartup],
  ] as const).flatMap(([name, reconcile]) => [false, true].map(fail => ({ name, reconcile, fail }))))
  ("counts detached $name startup writes after readiness (failure=$fail)", async ({ reconcile, fail }) => {
    let finishStartup!: () => void;
    const pending = new Promise<void>(resolve => { finishStartup = resolve; });
    vi.mocked(reconcile).mockImplementationOnce(async () => {
      await pending;
      if (fail) throw new Error("fixture startup write failed");
      return { reconciled: 0, seeded: 0, failed: 0 } as never;
    });
    const emptyDb = { transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ execute: async () => [{ blocked: false }] }) };
    const hold = { ownerId: "fixture-owner", draining: true, activeRuns: 0, pendingWakes: 0,
      startedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
    const report = () => readIdleSleepSafety(emptyDb as never, () => hold, Date.now, hold.ownerId, async () => "none");
    try {
      await startServer();
      await new Promise(resolve => setImmediate(resolve));
      expect(idleWorkSnapshot().active).toBe(1);
      expect((await report()).backgroundWork).toBe("unknown");
      finishStartup();
      await new Promise(resolve => setImmediate(resolve));
      expect(idleWorkSnapshot().active).toBe(0);
      expect((await report()).backgroundWork).toBe("none");
    } finally {
      finishStartup();
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  it.each([false, true])("counts an accepted backup until completion, including failure=%s", async fails => {
    await startServer();
    await new Promise(resolve => setImmediate(resolve));
    const before = idleWorkSnapshot().active;
    let resolveBackup!: (value: never) => void;
    let rejectBackup!: (error: Error) => void;
    vi.mocked(runDatabaseBackup).mockImplementationOnce(() => new Promise((resolve, reject) => {
      resolveBackup = resolve; rejectBackup = reject;
    }));
    const options = createAppMock.mock.calls[0]?.[1] as unknown as {
      databaseBackupService: { runManualBackup(): Promise<unknown> };
    };
    const backup = options.databaseBackupService.runManualBackup();
    await Promise.resolve();
    expect(idleWorkSnapshot().active).toBe(before + 1);
    if (fails) {
      const rejection = expect(backup).rejects.toThrow("backup failed");
      rejectBackup(new Error("backup failed"));
      await rejection;
    } else {
      resolveBackup({ backupFile: "backup.sql.gz", sizeBytes: 1, prunedCount: 0 } as never);
      await backup;
    }
    expect(idleWorkSnapshot().active).toBe(before);
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

  it("keeps startup available when completion delivery recovery fails", async () => {
    completionSweepMock.mockRejectedValueOnce(new Error("temporary delivery failure"));
    const { startServer } = await import("../index.js");
    await expect(startServer()).resolves.toBeDefined();
    expect(completionSweepMock).toHaveBeenCalled();
  });

  it("keeps activity-driven completion scans scoped to the changed task", async () => {
    await startServer();
    completionSweepMock.mockClear();
    const { publishLiveEvent } = await import("../services/live-events.js");
    publishLiveEvent({ companyId: "company-one", type: "activity.logged", payload: {
      action: "issue.updated", entityId: "task-one",
    } });
    expect(completionSweepMock).toHaveBeenCalled();
    for (const args of completionSweepMock.mock.calls) {
      expect(args).toEqual([{ companyId: "company-one", taskId: "task-one" }]);
    }
    completionSweepMock.mockClear();
    publishLiveEvent({ companyId: "company-two", type: "activity.logged", payload: { action: "issue.updated" } });
    expect(completionSweepMock).not.toHaveBeenCalled();
  });

  it("does not rescan idle tool health from the aggregate maintenance tick", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: true, heartbeatSchedulerIntervalMs: 30_000 }));
    let tick: (() => void) | undefined;
    const intervals = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
      if (ms === 30_000) tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      await startServer(); await settleStartupHousekeeping();
      const sweeps = vi.mocked(toolAccessService).mock.results.map(result => vi.mocked(result.value.sweepConnectionHealth));
      const count = () => sweeps.reduce((total, sweep) => total + sweep.mock.calls.length, 0);
      expect(count()).toBe(0);
      const registrations = deliveryWorkRegisterMock.mock.calls.filter(([queue]) => queue === DELIVERY_QUEUES.toolConnectionHealth);
      expect(registrations).toHaveLength(1);
      const loads = vi.mocked(toolAccessService).mock.results.map(result => result.value.scheduledHealth.load);
      const loadCount = () => loads.reduce((total, load) => total + load.mock.calls.length, 0);
      expect(loadCount()).toBe(1);
      expect(tick).toEqual(expect.any(Function));
      tick!(); await new Promise<void>(resolve => setImmediate(resolve));
      tick!(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(count()).toBe(0);
      expect(loadCount()).toBe(1);
    } finally { intervals.mockRestore(); }
  });

  it("never invokes the retired review detector at startup or on periodic recovery", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    const retiredDetector = vi.fn(async () => ({ created: 1, updated: 1, failed: 0 }));
    const runtime = Object.assign(heartbeatServiceMock, { reconcileProductivityReviews: retiredDetector });
    let intervalCallback: (() => void) | null = null;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      intervalCallback = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      await startServer();
      await settleStartupHousekeeping();
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(1);
      expect(intervalCallback).not.toBeNull();
      intervalCallback?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(heartbeatServiceMock.sweepStaleIssueLocks).toHaveBeenCalledTimes(2);
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      expect(retiredDetector).not.toHaveBeenCalled();
    } finally {
      delete (runtime as Partial<typeof runtime>).reconcileProductivityReviews;
      setIntervalSpy.mockRestore();
    }
  });

  it("loads secret expiry deadlines successfully during enabled startup", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: true }));
    await startServer();
    await settleStartupHousekeeping();
    const index = deliveryWorkRegisterMock.mock.calls.findIndex(([queue]) => queue === DELIVERY_QUEUES.secretProposalExpiry);
    expect(index).toBeGreaterThanOrEqual(0);
    await deliveryWorkRegisterMock.mock.results[index].value.ready;
    expect(deliveryWorkErrors.filter(({ queue }) => queue === DELIVERY_QUEUES.secretProposalExpiry)).toEqual([]);
    const service = vi.mocked(createSecretProposalsService).mock.results[0].value;
    expect(service.expiryDeadlines).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(service.sweepExpiredForCompany).not.toHaveBeenCalled();
  });

  it("registers native replacement recovery without an execution-control interval", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: true }));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      await startServer();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reconcileSafeNativeReplacements).toHaveBeenCalledExactlyOnceWith(
        createDbMock.mock.results[0]?.value,
        expect.any(Date),
        { verifyStoppedSession: expect.any(Function) },
      );
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.executionReplacement)).toBe(true);
      expect(setIntervalSpy.mock.calls.some(([, interval]) => interval === EXECUTION_RECONCILIATION_INTERVAL_MS)).toBe(false);
    } finally {
      setIntervalSpy.mockRestore();
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
      await settleStartupHousekeeping();

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
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(1);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.customImageExpiry)).toBe(true);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionContinuation)).toBe(true);
      const decisions = vi.mocked(decisionService).mock.results.at(-1)!.value;
      expect(decisions.sweepContinuations).toHaveBeenCalledTimes(1);
      expect(decisions.sweepTtlExpiry).toHaveBeenCalledTimes(1);
      expect(decisions.recoverEffects).toHaveBeenCalledTimes(1);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionEffectRecovery)).toBe(true);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionExpiry)).toBe(true);
      expect(decisions.sweepInvalidTargets).toHaveBeenCalledTimes(1);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionTargets)).toBe(true);
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

      // The disabled path still creates one heartbeat runtime. This runtime owns
      // the orphan-sandbox cleanup sweep, so a leaked provider sandbox is still
      // reaped at startup and on the interval.
      expect(heartbeatServiceFactoryMock).toHaveBeenCalledTimes(1);
      expect(heartbeatServiceMock.sweepPendingCleanupLeases).toHaveBeenCalled();
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      expect(intervalCallback).not.toBeNull();
      intervalCallback?.();
      await Promise.resolve();
      await Promise.resolve();

      expect(externalObjectsServiceMock.refreshDueObjectsForActiveCompanies).toHaveBeenCalledTimes(1);
      expect(routineServiceMock.tickScheduledTriggers).not.toHaveBeenCalled();
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).not.toHaveBeenCalled();
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionContinuation)).toBe(false);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionExpiry)).toBe(false);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionEffectRecovery)).toBe(false);
      expect(deliveryWorkRegisterMock.mock.calls.some(([queue]) => queue === DELIVERY_QUEUES.decisionTargets)).toBe(false);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it.each([false, true])("registers failed accounting recovery for delivery, independent of heartbeat scheduling: %s", async (enabled) => {
    loadConfigMock.mockReturnValue(buildTestConfig({ heartbeatSchedulerEnabled: enabled }));
    heartbeatServiceMock.reconcileCostAccounting.mockRejectedValueOnce(new Error("temporary ledger outage"));
    let tick: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      expect((await startServer()).server).toBe(fakeServer);
      await settleStartupHousekeeping();
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      expect(tick).toBeDefined();
      tick?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(1);
      const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.accounting);
      expect(registration?.[1]).toMatchObject({ retryMs: 5_000, runDuringDrain: true });
      await registration?.[1].run(new AbortController().signal);
      expect(heartbeatServiceMock.reconcileCostAccounting).toHaveBeenCalledTimes(2);
    } finally {
      timer.mockRestore();
    }
  });

  it("reports ready before startup housekeeping finishes and starts the scheduler after it", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    let releaseCleanup: (() => void) | undefined;
    environmentCustomImagesServiceMock.cleanupExpiredSetupSessions.mockImplementationOnce(() =>
      new Promise((resolve) => {
        releaseCleanup = () => resolve({ scanned: 0, timedOut: 0, failed: 0 });
      }));
    const heartbeatIntervals: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      interval: number,
    ) => {
      if (interval === 30000) heartbeatIntervals.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      await startServer();
      // Readiness does not wait for the hung housekeeping step.
      expect(getStartupRecoveryState().phase).toBe("ready");
      await settleStartupHousekeeping();
      expect(heartbeatIntervals).toHaveLength(0);

      releaseCleanup?.();
      await settleStartupHousekeeping();
      expect(heartbeatIntervals).toHaveLength(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("runs the remaining startup housekeeping steps when one fails", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    environmentCustomImagesServiceMock.cleanupExpiredSetupSessions.mockRejectedValueOnce(new Error("provider outage"));
    const heartbeatIntervals: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      interval: number,
    ) => {
      if (interval === 30000) heartbeatIntervals.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    try {
      await expect(startServer()).resolves.toBeDefined();
      await settleStartupHousekeeping();
      const registration = deliveryWorkRegisterMock.mock.calls.find(([queue]) => queue === DELIVERY_QUEUES.customImageExpiry);
      expect(registration).toBeDefined();
      expect(await registration![1].hasPending!()).toBe(true);
      expect(environmentCustomImagesServiceMock.nextSetupCleanupAt).not.toHaveBeenCalled();
      // The scheduler starts only after every housekeeping step settled.
      expect(heartbeatIntervals).toHaveLength(1);
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

  it("closes the bound listener when native startup recovery fails", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      heartbeatSchedulerEnabled: true,
      heartbeatSchedulerIntervalMs: 30000,
    }));
    heartbeatServiceMock.recoverNativeRunsAfterRestart.mockRejectedValueOnce(
      new Error("native recovery unavailable"),
    );

    await expect(startServer()).rejects.toThrow("native recovery unavailable");

    expect(fakeServer.listen).toHaveBeenCalledTimes(1);
    expect(fakeServer.close).toHaveBeenCalledTimes(1);
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

  it("checks port availability on the configured bind host", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      host: "127.0.0.1",
      port: 3210,
    }));

    await startServer();

    expect(detectPortMock).toHaveBeenCalledWith({
      port: 3210,
      hostname: "127.0.0.1",
    });
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

  it("preserves explicit-port external auth public URLs when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      port: 3100,
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://my-host.ts.net:3100",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    // The server listens internally on 3110, but an explicit *external* base URL must keep
    // its advertised port. Rewriting it to the internal listen port produced an unreachable
    // URL that leaked to spawned agents as a dead PAPERCLIP_API_URL. (BRO-1558)
    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("http://my-host.ts.net:3100");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://my-host.ts.net:3100");
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
