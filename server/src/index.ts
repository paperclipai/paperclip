import { registerToolConnectionHealthWork } from "./services/tool-connection-health-work.js";
import { approvalQueueSeedingService, registerApprovalQueueSeedingWork } from "./services/approval-queue-seeding-work.js";
import { joinRequestRetentionService, registerJoinRequestRetentionWork } from "./services/join-request-retention.js";
import { approvalRetentionService, registerApprovalRetentionWork } from "./services/approval-retention.js";
import { registerDecisionTargetWork } from "./services/decision-target-work.js";
import { registerDecisionEffectRecoveryWork } from "./services/decision-effect-recovery-work.js";
import { registerDecisionExpiryWork } from "./services/decision-expiry-work.js";
import { registerDecisionContinuationWork } from "./services/decision-continuation-work.js";

import { registerDecisionArchiveDeliveryWork } from "./services/decision-archive-delivery-work.js";

import { registerToolReviewProjectionWork } from "./services/tool-review-projection-work.js";
import { registerToolReviewInterruptionWork } from "./services/tool-review-interruption-work.js";
import { registerToolReviewRecoveryWork } from "./services/tool-review-recovery-work.js";
import { registerToolReviewExpiryWork } from "./services/tool-review-expiry-work.js";
import { registerGatewayCredentialExpiryWork } from "./services/gateway-credential-expiry-work.js";
import { registerSecretProposalExpiryWork } from "./services/secret-proposal-expiry-work.js";
import { registerCustomImageCleanupWork } from "./services/custom-image-cleanup-work.js";
import { registerWorkspaceRecoveryWork } from "./services/workspace-recovery-work.js";
import { registerEnvironmentCleanupWork } from "./services/environment-cleanup-work.js";
import { loginCleanupSchedule } from "./services/login-cleanup-state.js";
import { registerLoginCleanupWork } from "./services/login-cleanup-work.js";
import { timeStartupRecovery } from "./startup-recovery-timing.js";
import { skillSourceSyncService } from "./services/skill-source-sync.js";
import {
  SKILL_VERSION_RETENTION_INTERVAL_MS,
  SKILL_VERSION_RETENTION_STARTUP_DELAY_MS,
  skillVersionRetentionService,
} from "./services/skill-version-retention.js";
import {
  NATIVE_HARNESS_BACKUP_EXPIRATION_INTERVAL_MS,
  NATIVE_HARNESS_BACKUP_EXPIRATION_STARTUP_DELAY_MS,
  nativeHarnessBackupExpirationService,
} from "./services/native-runtime/native-harness-backup-expiration.js";
import { onNativeRunnerEvidence } from "./services/native-runtime/native-runner-evidence-signal.js";
import { gitRestorePointRetentionService, registerGitRestorePointWork } from "./services/git-restore-point-ledger.js";
import {
  nativeWorkspaceSyncRetentionService,
  registerNativeWorkspaceSyncRetentionWork,
} from "./services/native-runtime/native-workspace-sync-retention.js";
import { markGitRestorePointExpired } from "./services/git-restore-point-storage.js";
import { subscribeAllCompanyLiveEvents } from "./services/live-events.js";
import { DELIVERY_QUEUES } from "./services/delivery-work-notifications.js";
import { registerBudgetEnforcementWork, registerCostAccountingWork } from "./services/budget-enforcement-worker.js";
import { caseHandoffDeliveryService } from "./services/case-handoff-delivery.js";
import { registerScheduledWork } from "./services/scheduled-work.js";
import type { createDeliveryWorkCoordinator } from "./services/delivery-work-coordinator.js";
import { registerTerminalWorkspaceWork, TERMINAL_WORKSPACE_RETRY_MS } from "./services/terminal-workspace-work.js";
import { isIdleTaskDrainActive, beginIdleTrackedWork, trackIdleWork, registerTaskDrainExpiryWork } from "./services/task-admission.js";
import { markIdleStartupComplete, registerIdleLocalWorkProbe } from "./services/idle-local-work.js";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "./services/idle-database-backup.js";
import { cloudWarmStandbyServerOptions } from "./middleware/cloud-warm-standby.js";
import { createCloudWarmStandby } from "./services/cloud-warm-standby.js";
import { chatCompletionDeliveryService } from "./services/chat-completion-delivery.js";
/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { createTrackedSingleFlight } from "./lib/single-flight.js";
import { sentryReady, shutdownSentry, captureException } from "./sentry.js";
import { setSentryRunLinkResolver } from "./sentry-links.js";
import { createSentryRunLinkResolver } from "./services/sentry-run-links.js";
import { waitForPendingRunFailureReports } from "./services/run-failure-report.js";
import { verifyStoppedNativeSessionForReplacement } from "./services/native-runtime/native-session-executor.js";
import { embeddedPostgresOwnerPort } from "./embedded-postgres-owner.js";
import { deliverExecutionStatuses } from "./services/execution-status-delivery.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./services/execution-recovery-resolution.js";
import { reconcileSafeNativeReplacements } from "./services/native-runtime/native-safe-replacement.js";
import { reconcileAbandonedExecutionControl } from "./services/execution-control-reconciliation.js";
import { executionControlSchedule, registerExecutionControlWork } from "./services/execution-control-work.js";
import { connectionIntentDeliveryService } from "./services/connection-intent-delivery.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Server, RequestListener } from "node:http";
import { createPaperclipHttpServer } from "./http/server.js";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { warnIfUnsupportedNodeVersion } from "@paperclipai/shared/node-version";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  prepareEmbeddedPostgresNativeRuntime,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  closeLivenessDb,
  closeCheckpointDb,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { createIncompleteTaskWatchdogScanReporter } from "./services/task-watchdog-diagnostics.js";
import { setStartupRecoveryPhase } from "./startup-recovery-state.js";
import {
  StartupRefusalError,
  migrationRefusalError,
  shouldReportStartupFailure,
} from "./startup-refusals.js";
import {
  getManagedInstanceConfig,
  type ManagedInstanceConfig,
} from "./services/managed-config.js";
import { getOperatorSettingDefaults } from "./services/setting-defaults.js";
import { setupEnvironmentCustomImageTerminalWebSocketServer } from "./realtime/environment-custom-image-terminal-ws.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "./middleware/auth.js";
import {
  feedbackService,
  applyManagedEnvironments,
  attentionService,
  backfillPrincipalAccessCompatibility,
  backfillLegacyToolOAuthTokens,
  bootstrapExecutionPolicyFromEnv,
  environmentCustomImageService,
  decisionService,
  decisionRetentionService,
  externalObjectService,
  executionWorkspaceService,
  heartbeatService,
  issueThreadInteractionService,
  githubConnectionEventService,
  issueService,
  instanceSettingsService,
  reconcileBuiltInAgentsOnStartup,
  reconcileCodexLocalManagedHomesOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
  statusCardService,
  toolAccessService,
  workspaceOperationService,
} from "./services/index.js";
import { questionResponseDeliveryService } from "./services/question-response-delivery.js";
import { deliverNativeQuestionResponse } from "./services/native-runtime/native-question-bridge.js";
import { queueIssueAssignmentWakeup } from "./services/issue-assignment-wakeup.js";
import { createSecretProposalsService } from "./services/secret-proposals.js";
import { environmentRuntimeService } from "./services/environment-runtime.js";
import { historicalCleanupVerificationService } from "./services/historical-cleanup-verification.js";
import { isCloudManagedInstance } from "./services/cloud-instance.js";
import { createDbAdapterAuthSessionStore } from "./services/device-login-service.js";
import {
  createDeviceLoginReaper,
  createProductionLoginSessionReaperRuntime,
} from "./services/device-login-reaper.js";
import { createProductionSetupTokenReaper } from "./services/setup-token-reaper.js";
import { localAiLoginService } from "./services/local-ai-login.js";
import { registerGitHubBotCloudSetupPoller } from "./services/chat-github-cloud-ingress.js";
import { resolveWorktreeRunExecutionActivationState } from "./services/instance-settings.js";
import {
  parseAdapterRegistryEnv,
  reconcileAdapterAvailability,
} from "./services/adapter-registry-bootstrap.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { isLoopbackHost, rewriteLoopbackUrlPort } from "./url-utils.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import { ensureDecisionSigningSecret } from "./services/decision-signing.js";
import { createDecisionRetentionNotifyOriginAgent, createDecisionWakeOriginAgent } from "./services/decision-wakeup.js";
import {
  closeHttpListenerForShutdown,
  coordinateHeartbeatSchedulerShutdown,
  drainRunExecutionFinalizersForShutdown,
  finalizeServerShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
} from "./shutdown.js";
import { initializeCloudRuntimeIdentity } from "./services/cloud-runtime-identity.js";
import { systemdNotify } from "./services/systemd-notify.js";
import { flushInFlightRunLogMirrors } from "./services/run-log-store.js";
import {
  createEmbeddedPostgresSupervisor,
  type EmbeddedPostgresSupervisor,
  type SupervisedEmbeddedPostgres,
} from "./embedded-postgres-supervisor.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = SupervisedEmbeddedPostgres & {
  initialise(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: Server;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
  shutdown: (signal?: "SIGINT" | "SIGTERM") => Promise<void>;
}

// Set by the boot sequence once the primary pool exists. A boot that fails
// after that point (a bootstrap query that throws, for example) must end the
// pool before the caller exits: the driver keeps idle connections open until
// the process dies, and in a restart loop the leftover backends of every
// failed generation can exhaust `max_connections` before the next boot even
// gets a connection.
type StartupDatabaseTeardown = { close: (() => Promise<void>) | null };

// Ends the pool behind a drizzle client. Tolerates a client without `$client`
// (test doubles) and never throws, so it is safe on every exit path.
async function endDatabaseClient(client: unknown, timeoutSeconds: number): Promise<void> {
  const sql = (client as { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } } | null)
    ?.$client;
  if (typeof sql?.end !== "function") return;
  await sql.end({ timeout: timeoutSeconds });
}

export async function startServer(): Promise<StartedServer> {
  const startupDatabase: StartupDatabaseTeardown = { close: null };
  try {
    return await startServerWithDatabaseTeardown(startupDatabase);
  } catch (error) {
    if (startupDatabase.close) {
      await startupDatabase.close().catch((closeError) => {
        logger.error({ err: closeError }, "failed to close database clients after startup failure");
      });
    }
    throw error;
  }
}

async function startServerWithDatabaseTeardown(
  startupDatabase: StartupDatabaseTeardown,
): Promise<StartedServer> {
  setStartupRecoveryPhase("starting");
  warnIfUnsupportedNodeVersion(process.versions.node, (message) => logger.warn(message));

  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
  // Error monitoring must be ready before the first request can fail — see
  // sentry.ts.
  await sentryReady;
  ensureDecisionSigningSecret();
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      // A database with zero applied migrations and zero tables has
      // never been migrated: under a managed-cloud supervisor that is
      // the expected first-boot race (the harness migrates and
      // restarts), so the refusal carries the supervised-transient
      // class. Applied history — or pre-existing tables beside an empty
      // journal — means drift and keeps the plain, always-reported
      // Error.
      throw migrationRefusalError(
        state,
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }

    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isPostgresConnectionString(connectionString: string): boolean {
    try {
      const parsed = new URL(connectionString);
      return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
    } catch {
      return false;
    }
  }

  function assertCloudDatabaseContract(): void {
    if (config.deploymentMode !== "authenticated" || config.deploymentExposure !== "public") {
      return;
    }
    if (!config.databaseUrl) {
      // Under a managed-cloud supervisor a missing DATABASE_URL on boot
      // is the config-application race (the container can start before
      // the staged variables land), not operator error — the supervisor
      // restarts once the config holds. A malformed value below is a
      // real misconfiguration and stays an always-reported Error.
      throw new StartupRefusalError(
        "database-contract-unmet",
        "authenticated public deployments require DATABASE_URL or config.database.connectionString; refusing embedded PostgreSQL fallback",
      );
    }
    if (!isPostgresConnectionString(config.databaseUrl)) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
      );
    }
  }

  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let pluginMigrationDb;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresSupervisor: EmbeddedPostgresSupervisor | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  assertCloudDatabaseContract();
  if (config.databaseUrl) {
    const migrationUrl = config.databaseMigrationUrl ?? config.databaseUrl;
    migrationSummary = await ensureMigrations(migrationUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    pluginMigrationDb = config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      // embedded-postgres registers async-exit-hook handlers as an import side
      // effect. Those handlers stop PostgreSQL immediately on SIGINT/SIGTERM,
      // racing Paperclip's later heartbeat snapshot query. Paperclip explicitly
      // stops the managed cluster in its own ordered shutdown path instead.
      const mod = await loadWithoutCoordinatedShutdownSignalHooks(
        () => import(moduleName),
      );
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
    await prepareEmbeddedPostgresNativeRuntime();
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      port = embeddedPostgresOwnerPort(readFileSync(postmasterPidFile, "utf8"), dataDir, runningPid);
      const actualDataDir = await getPostgresDataDirectory(`postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`);
      if (typeof actualDataDir !== "string" || resolve(actualDataDir) !== resolve(dataDir)) {
        throw new Error("Refusing to reuse PostgreSQL: its data directory belongs to another instance.");
      }
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        const createEmbeddedPostgres = () => new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });
        embeddedPostgres = createEmbeddedPostgres();

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
        embeddedPostgresSupervisor = createEmbeddedPostgresSupervisor({
          initialInstance: embeddedPostgres,
          createInstance: createEmbeddedPostgres,
          beforeRestart: () => {
            const runningPostgresPid = getRunningPid();
            if (runningPostgresPid) {
              throw new Error(`Refusing embedded PostgreSQL recovery because the data directory reports a live process (pid=${runningPostgresPid})`);
            }
            if (existsSync(postmasterPidFile)) rmSync(postmasterPidFile, { force: true });
          },
          onUnexpectedExit: (code, signal) => logger.error(
            { code, signal, recentLogs: logBuffer.getRecentLogs() },
            "Embedded PostgreSQL exited unexpectedly; attempting recovery",
          ),
          onRestartAttemptFailed: (err, attempt) => logger.error(
            { err, attempt, recentLogs: logBuffer.getRecentLogs() },
            "Embedded PostgreSQL recovery attempt failed",
          ),
          onRestarted: (attempt) => logger.info(
            { attempt, port },
            "Embedded PostgreSQL recovered after unexpected exit",
          ),
          onRecoveryExhausted: (err) => {
            logger.fatal(
              { err, recentLogs: logBuffer.getRecentLogs() },
              "Embedded PostgreSQL recovery exhausted; stopping the unhealthy server",
            );
            process.kill(process.pid, "SIGTERM");
          },
        });
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
    pluginMigrationDb = db;
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }

  // Ends every pool this process opened. Used by the orderly shutdown path
  // (after the application services, before the embedded provider stops) and
  // by the fail-loud startup path, so no exit leaves pooled backends behind.
  const closeDatabaseClients = async () => {
    setSentryRunLinkResolver(null);
    const clients = pluginMigrationDb === db ? [db] : [db, pluginMigrationDb];
    await Promise.all([...clients.map((client) => endDatabaseClient(client, 5)), closeLivenessDb(db, 5), closeCheckpointDb(db, 5)]);
  };
  startupDatabase.close = closeDatabaseClients;
  setSentryRunLinkResolver(createSentryRunLinkResolver(db));
  
  // A claimed warm-pool stack may restart while its provider environment still
  // names the pool host. Restore the signed, durable identity before Better
  // Auth, routes, or child-runtime configuration capture any public URL.
  const restoredCloudRuntimeIdentity = await initializeCloudRuntimeIdentity(db as any);
  if (restoredCloudRuntimeIdentity) config = loadConfig();
  const isWarmStandby = await createCloudWarmStandby(db as any);

  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }

  const requestedListenPort = config.port;
  const listenPort = await detectPort({
    port: requestedListenPort,
    hostname: config.host,
  });
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLoopbackUrlPort(config.authPublicBaseUrl, listenPort);
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
  if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
    logger.info(accessBackfill, "Backfilled principal access compatibility records");
  }
  const toolOAuthBackfill = await backfillLegacyToolOAuthTokens(db as any);
  if (toolOAuthBackfill.sanitizedConnections > 0 || toolOAuthBackfill.migratedConnections > 0) {
    logger.info(toolOAuthBackfill, "Backfilled legacy tool OAuth credentials into company secrets");
  }
  const confirmationSweep = await issueThreadInteractionService(db as any)
    .sweepSupersededPendingRequestConfirmations();
  if (confirmationSweep.expired > 0) {
    logger.info(confirmationSweep, "Expired pending confirmations superseded by newer agent requests");
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config, { listenPort });
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }

  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  // Cloud managed-config contract (harness → app). Parse PAPERCLIP_MANAGED_CONFIG
  // once so a malformed document (blank value, bad JSON, unknown feature key,
  // unsupported v, missing section) refuses startup with a precise error instead
  // of silently running without the feature overlay. Absent env = self-hosted:
  // nothing changes. The parsed document is never persisted; instanceSettingsService
  // overlays it per read. This MUST run before any instanceSettingsService(db)
  // construction — that constructor parses the same env, and it would otherwise
  // throw first, bypassing this fail-closed log path.
  let managedConfig: ManagedInstanceConfig | null;
  try {
    managedConfig = getManagedInstanceConfig();
    if (managedConfig) {
      logger.warn(
        {
          catalogVersion: managedConfig.catalogVersion,
          managedFeatureKeys: Object.keys(managedConfig.features).sort(),
          autoInstallPlugins: [...managedConfig.plugins.autoInstall],
        },
        "cloud managed configuration active",
      );
    }
  } catch (err) {
    logger.error({ err }, "invalid PAPERCLIP_MANAGED_CONFIG; refusing to start (fail closed)");
    throw err;
  }

  // Operator setting defaults (PAPERCLIP_SETTING_DEFAULTS). Same fail-closed
  // posture as the managed-config parse above: malformed JSON or an invalid
  // value for a known field refuses startup; unknown field names only warn.
  try {
    const operatorDefaults = getOperatorSettingDefaults();
    if (operatorDefaults && Object.keys(operatorDefaults).length > 0) {
      logger.warn(
        { defaultedSettings: Object.keys(operatorDefaults).sort() },
        "operator setting defaults active",
      );
    }
  } catch (err) {
    logger.error({ err }, "invalid PAPERCLIP_SETTING_DEFAULTS; refusing to start (fail closed)");
    throw err;
  }

  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const backupSettingsSvc = instanceSettingsService(db);
  const databaseBackupMaxAgeHours = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS) ||
      Math.max(26, Math.ceil((config.databaseBackupIntervalMinutes / 60) * 2)),
  );
  const databaseBackupAlertFile =
    process.env.PAPERCLIP_DB_BACKUP_ALERT_FILE ||
    resolve(config.databaseBackupDir, "..", "health", "db-backup-to-s3.failure");
  const databaseBackupAlertFiles = [
    databaseBackupAlertFile,
    resolve(config.databaseBackupDir, "db-backup-to-s3.failure"),
    resolve(config.databaseBackupDir, "..", "db-backup-to-s3.failure"),
  ];
  let databaseBackupInFlight = false;
  const idleDatabaseBackupEnabled = config.databaseBackupEnabled
    && process.env.PAPERCLIP_DB_BACKUP_IDLE_CHECKPOINT_ENABLED === "1";
  const runServerDatabaseBackup = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const finishIdleBackup = beginIdleTrackedWork();
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "manual" ? "Manual" : trigger === "idle" ? "Pre-sleep" : "Automatic";
    try {
      if (trigger === "idle") await markIdleBackupWakeRequired(config.databaseBackupDir);
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;
      const verifyCheckpoint = trigger === "idle" || existsSync(idleBackupWakeMarker(config.databaseBackupDir));

      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retention,
        filenamePrefix: "paperclip",
        verifyBeforePrune: verifyCheckpoint ? verifyIdleDatabaseBackup : undefined,
      });
      if (verifyCheckpoint) {
        if (trigger !== "idle") await clearIdleBackupWakeRequired(config.databaseBackupDir);
      }
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: config.databaseBackupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
      finishIdleBackup();
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
  const reportIncompleteWatchdogScans = createIncompleteTaskWatchdogScanReporter(
    (details, message) => logger.warn(details, message),
  );
  const heartbeat = config.heartbeatSchedulerEnabled
    ? heartbeatService(db as any, { pluginWorkerManager })
    : null;
  const accountingHeartbeat = heartbeat ?? heartbeatService(db as any, { pluginWorkerManager });
  const decisionServiceOptions = {
    wakeOriginAgent: createDecisionWakeOriginAgent(heartbeat?.wakeup ?? null),
  };
  // Managed instances drive bundled plugin auto-install from the managed-config
  // document parsed fail-closed above (`plugins.autoInstall`). Absent env means
  // self-hosted: createApp falls back to its built-in kubernetes-only default.
  const managedPluginAutoInstall = managedConfig?.plugins.autoInstall ?? null;
  const app = await createApp(db as any, {
    prepareIdleDatabaseBackup: idleDatabaseBackupEnabled
      ? async () => (await runServerDatabaseBackup("idle")) !== null
      : undefined,
    cloudWarmStandby: isWarmStandby,
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    databaseBackupService: {
      runManualBackup: async () => {
        const result = await runServerDatabaseBackup("manual");
        if (!result) {
          throw conflict("Database backup already in progress");
        }
        return result;
      },
    },
    databaseBackupHealth: config.databaseBackupEnabled
      ? {
          enabled: config.databaseBackupEnabled,
          backupDir: config.databaseBackupDir,
          maxAgeHours: databaseBackupMaxAgeHours,
          alertFile: databaseBackupAlertFile,
          alertFiles: databaseBackupAlertFiles,
        }
      : undefined,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authPublicBaseUrl: config.authPublicBaseUrl,
    chatWebhookPublicBaseUrl: config.chatWebhookPublicBaseUrl,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    announcements: { enabled: config.announcementsEnabled, feedUrl: config.announcementsFeedUrl },
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
    decisionServiceOptions,
    managedPluginAutoInstall,
  });
  
  if (listenPort !== requestedListenPort) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiUrl = choosePrimaryRuntimeApiUrl({
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  const configuredApiUrl = process.env.PAPERCLIP_API_URL?.trim() || runtimeApiUrl;
  // Upgrade admission runs before every WebSocket listener, outside Express.
  const server = createPaperclipHttpServer(app as unknown as RequestListener, {
    apiUrl: configuredApiUrl,
    httpOptions: cloudWarmStandbyServerOptions(() => isWarmStandby() || isIdleTaskDrainActive()),
  });
  // Outlive reverse-proxy idle timeouts to avoid intermittent resets.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  const runtimeApiCandidates = buildRuntimeApiCandidateUrls({
    preferredApiUrl: configuredApiUrl,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_RUNTIME_API_URL = runtimeApiUrl;
  process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify(runtimeApiCandidates);
  process.env.PAPERCLIP_API_URL = configuredApiUrl;

  let startupListenerBound = false;
  try {
  setupEnvironmentCustomImageTerminalWebSocketServer(server, db as any, {
    pluginWorkerManager,
  });
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
    // Cloud-proxied browsers carry trusted x-paperclip-cloud-* headers instead
    // of a local Better Auth session; without this lane every live-events
    // upgrade behind the Cloud front door 403s forever. The resolver is
    // self-gating: it returns null unless PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN
    // is configured and the request presents the matching trust token, so
    // self-hosted deployments never take this path.
    resolveCloudActor: async (req) => {
      const actor = await resolveCloudTenantActor(
        db as any,
        cloudActorHeaderSourceFromHeaders(req.headers),
      );
      if (!actor?.userId || !actor.companyIds) return null;
      return { userId: actor.userId, companyIds: actor.companyIds };
    },
  });

  setStartupRecoveryPhase("recovering");
  // Bind the shared HTTP/PRP listener before native startup recovery. A
  // runnerd process that survived a controller crash is already reconnecting
  // to this address; delaying listen until after orphan reconciliation makes
  // authenticated adoption impossible and turns a healthy process into a
  // duplicate-provider risk.
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };
    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(
        `Server listener bound on ${config.host}:${listenPort}; startup recovery in progress`,
      );
      resolveListen();
    });
  });
  startupListenerBound = true;

  try {
    const result = await workspaceOperationService(db as any)
      .reconcileStaleRuntimeControlOperations();
    if (result.reconciled > 0) {
      logger.warn(
        { reconciled: result.reconciled, operationIds: result.operationIds },
        "reconciled stale managed runtime control operations from a previous server process",
      );
    }
  } catch (err) {
    logger.error({ err }, "startup reconciliation of managed runtime control operations failed");
  }

  // These jobs need not delay readiness, but their writes must finish before
  // an idle report can authorize sleep. Count the whole detached promise.
  void trackIdleWork(reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (
        result.reconciled > 0
        || result.restarted > 0
        || result.restartFailed > 0
        || result.backfilled > 0
      ) {
        logger.warn(
          {
            reconciled: result.reconciled,
            adopted: result.adopted,
            stopped: result.stopped,
            // Managed HTTP-only services taken down so they come back on a
            // verified HTTPS origin (PAP-17158).
            httpsBackfilled: result.backfilled,
            restarted: result.restarted,
            restartFailed: result.restartFailed,
          },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    }));

  // Backfill auth.json into any already-isolated codex_local managed home that
  // was created by the #8272 isolation guard before the Phase 1 seeding fix.
  // Idempotent; the Phase 1 execute-time seeding covers new strandings.
  void trackIdleWork(reconcileCodexLocalManagedHomesOnStartup(db)
    .then((result) => {
      if (result.seeded > 0 || result.failed > 0) {
        logger.warn(
          { seeded: result.seeded, failed: result.failed, scanned: result.scanned },
          "reconciled codex_local managed homes (backfilled missing auth)",
        );
      }
      if (result.sourceAuthMissing > 0) {
        logger.warn(
          { sourceAuthMissing: result.sourceAuthMissing, scanned: result.scanned },
          "could not backfill codex_local managed homes because shared Codex auth is missing",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of codex_local managed homes failed");
    }));

  void trackIdleWork(reconcileBuiltInAgentsOnStartup(db as any)
    .then((result) => {
      if (
        result.reconciled > 0
        || result.unknown > 0
        || result.duplicates > 0
        || result.autoEnsured > 0
        || result.companyFailures > 0
      ) {
        logger.warn(
          result,
          "startup reconciliation of built-in agents complete",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of built-in agents failed");
    }));

  // Force the instance onto the Kubernetes sandbox provider when configured via
  // env (PAPERCLIP_EXECUTION_MODE=kubernetes). Runs BEFORE the heartbeat resumes
  // queued runs so the policy + managed k8s environments are in place. A bad
  // PAPERCLIP_EXECUTION_MODE / PAPERCLIP_K8S_* value throws and fails startup
  // (fail-loud) rather than silently allowing local execution.
  try {
    const policyResult = await bootstrapExecutionPolicyFromEnv(db as any);
    if (policyResult) {
      logger.warn(
        {
          executionMode: policyResult.executionMode,
          companiesConfigured: policyResult.companiesConfigured,
        },
        "forced execution policy applied at startup",
      );
    }
  } catch (err) {
    logger.error({ err }, "failed to apply forced execution policy from environment");
    throw err;
  }

  // Ensure sandbox environments declared in the managed-config document
  // (`environments` section) before the heartbeat resumes queued runs. The
  // document already parsed fail-closed above; the ensure step itself is
  // fail-safe per entry (a degraded boot beats a fleet-wide crash loop), but
  // a contradictory deployment that also forces PAPERCLIP_EXECUTION_MODE
  // throws here and fails startup. `pluginsReady` sequences the ensure after
  // the bundled-plugin install/load pass so a declared environment never
  // activates before its provider driver is registered; the worker manager
  // additionally gates each entry on a live plugin worker (and archives the
  // row of a provider that did not come up).
  try {
    const bundledPluginsStartup = (app as { locals?: { bundledPluginsStartup?: Promise<unknown> } })
      .locals?.bundledPluginsStartup;
    const managedEnvironmentsResult = await applyManagedEnvironments(db as any, managedConfig, {
      pluginsReady: bundledPluginsStartup,
      workerManager: pluginWorkerManager,
    });
    if (managedEnvironmentsResult) {
      logger.warn(managedEnvironmentsResult, "managed sandbox environments ensured from managed config");
    }
  } catch (err) {
    logger.error({ err }, "failed to apply managed environments from managed config");
    throw err;
  }

  let drainHeartbeatRunsForShutdown: ((
    signal: "SIGINT" | "SIGTERM",
    runIds?: readonly string[] | null,
  ) => Promise<unknown>) | null = null;
  let drainHeartbeatExecutionFinalizers: (() => Promise<void>) | null = null;
  let prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<{
    skipDrain: boolean;
    drainRunIds?: string[];
  }>) | null = null;
  let heartbeatSchedulerStopped = false;
  let heartbeatSchedulerInterval: ReturnType<typeof setInterval> | null = null;
  const heartbeatSchedulerInFlight = new Set<Promise<void>>();
  const trackHeartbeatSchedulerWork = (work: Promise<unknown>) => {
    const finishIdleWork = beginIdleTrackedWork();
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(() => undefined, () => undefined)
      .finally(() => {
        heartbeatSchedulerInFlight.delete(tracked);
        finishIdleWork();
      });
    heartbeatSchedulerInFlight.add(tracked);
  };
  const runPeriodicRecovery = createTrackedSingleFlight({
    trackWork: trackHeartbeatSchedulerWork,
    onSkipped: (inFlightForMs) => {
      if (inFlightForMs >= 3 * config.heartbeatSchedulerIntervalMs) {
        logger.error({ inFlightForMs }, "periodic heartbeat recovery remains in flight; duplicate pass suppressed");
      } else {
        logger.warn({ inFlightForMs }, "skipped periodic heartbeat recovery tick; previous chain still in flight");
      }
    },
  });
  const waitForHeartbeatSchedulerIdle = async () => {
    while (heartbeatSchedulerInFlight.size > 0) {
      await Promise.allSettled([...heartbeatSchedulerInFlight]);
    }
  };
  const startHeartbeatSchedulerInterval = (callback: () => void) => {
    heartbeatSchedulerInterval = setInterval(() => {
      if (!isWarmStandby() && !isIdleTaskDrainActive()) callback();
    }, config.heartbeatSchedulerIntervalMs);
    heartbeatSchedulerInterval?.unref?.();
  };
  const skillSourceSync = skillSourceSyncService(db as any);
  // Materialized skill versions are disk caches of version rows. The sweep is
  // single-flight, bounded per tick, and stops between removals on shutdown or
  // idle drain. The first sweep runs after startup without delaying readiness.
  const skillVersionRetention = skillVersionRetentionService(db as any, {
    dryRun: config.skillVersionRetentionDryRun,
    keepNewest: config.skillVersionRetentionKeepNewest,
    graceMs: config.skillVersionRetentionGraceMinutes * 60 * 1000,
    shouldContinue: () => !heartbeatSchedulerStopped && !isIdleTaskDrainActive() && !isWarmStandby(),
  });
  let skillVersionRetentionInFlight = false;
  let skillVersionRetentionContinuation: ReturnType<typeof setTimeout> | undefined;
  const sweepSkillVersionSnapshots = () => {
    if (!config.skillVersionRetentionEnabled || skillVersionRetentionInFlight || isIdleTaskDrainActive() || heartbeatSchedulerStopped || isWarmStandby()) return;
    skillVersionRetentionInFlight = true;
    trackHeartbeatSchedulerWork(skillVersionRetention.tick()
      .then((result) => {
        if (result.checked > 0 || result.failed > 0 || Object.keys(result.skipped).length > 0) {
          logger.info({ ...result, dryRun: config.skillVersionRetentionDryRun }, "skill version snapshot retention");
        }
        if (result.truncated && !heartbeatSchedulerStopped) {
          skillVersionRetentionContinuation = setTimeout(sweepSkillVersionSnapshots, 1000);
          skillVersionRetentionContinuation.unref?.();
        }
      })
      .catch((err) => {
        logger.error({ err }, "skill version snapshot retention failed");
      })
      .finally(() => { skillVersionRetentionInFlight = false; }));
  };
  const skillVersionRetentionInterval = setInterval(sweepSkillVersionSnapshots, SKILL_VERSION_RETENTION_INTERVAL_MS);
  skillVersionRetentionInterval.unref?.();
  const skillVersionRetentionStartup = setTimeout(sweepSkillVersionSnapshots, SKILL_VERSION_RETENTION_STARTUP_DELAY_MS);
  skillVersionRetentionStartup.unref?.();
  const nativeHarnessBackupExpiration = nativeHarnessBackupExpirationService(db as any, {
    dryRun: config.nativeHarnessBackupExpirationDryRun,
    closedForDays: config.nativeHarnessBackupExpirationDays,
    evidenceRetentionDays: config.nativeRunnerEvidenceRetentionDays,
    shouldContinue: () => !heartbeatSchedulerStopped && !isIdleTaskDrainActive() && !isWarmStandby(),
  });
  const unsubscribeNativeRunnerEvidence = onNativeRunnerEvidence(nativeHarnessBackupExpiration.noteEvidence);
  let nativeHarnessBackupExpirationInFlight = false;
  let nativeHarnessBackupExpirationContinuation: ReturnType<typeof setTimeout> | undefined;
  const sweepNativeHarnessBackups = () => {
    if (!config.nativeHarnessBackupExpirationEnabled || nativeHarnessBackupExpirationInFlight || isIdleTaskDrainActive() || heartbeatSchedulerStopped || isWarmStandby()) return;
    nativeHarnessBackupExpirationInFlight = true;
    trackHeartbeatSchedulerWork(nativeHarnessBackupExpiration.tick()
      .then((result) => {
        if (result.candidates > 0 || result.evidenceCandidates > 0 || result.failed > 0) {
          logger.info({ ...result, dryRun: config.nativeHarnessBackupExpirationDryRun }, "native harness backup expiration");
        }
        if (result.truncated && !heartbeatSchedulerStopped) {
          nativeHarnessBackupExpirationContinuation = setTimeout(sweepNativeHarnessBackups, 1000);
          nativeHarnessBackupExpirationContinuation.unref?.();
        }
      })
      .catch((err) => {
        logger.error({ err }, "native harness backup expiration failed");
      })
      .finally(() => { nativeHarnessBackupExpirationInFlight = false; }));
  };
  const nativeHarnessBackupExpirationInterval = setInterval(sweepNativeHarnessBackups, NATIVE_HARNESS_BACKUP_EXPIRATION_INTERVAL_MS);
  nativeHarnessBackupExpirationInterval.unref?.();
  const nativeHarnessBackupExpirationStartup = setTimeout(sweepNativeHarnessBackups, NATIVE_HARNESS_BACKUP_EXPIRATION_STARTUP_DELAY_MS);
  nativeHarnessBackupExpirationStartup.unref?.();
  const externalObjects = externalObjectService(db as any, {
    pluginWorkerManager,
    enabled: async () => (await instanceSettingsService(db).getExperimental()).enableExternalObjects === true,
  });
  const scheduleExternalObjectRefreshSweep = (now = new Date()) => {
    if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
    trackHeartbeatSchedulerWork(externalObjects
      .refreshDueObjectsForActiveCompanies(50, now)
      .then((result) => {
        if (result.checked > 0 || result.refreshed > 0) {
          logger.info({ ...result }, "external-object scheduler tick refreshed due objects");
        }
      })
      .catch((err) => {
        logger.error({ err }, "external-object scheduler tick failed");
      }));
  };

  // The retry backstop for orphan sandboxes. An acquire that rejects a
  // foreign-company insert tears the provisioned sandbox down. If that teardown
  // also fails, the acquire records a lease-less `pending_cleanup` lease row. No
  // other path releases that sandbox, so the master pending-cleanup sweep retries
  // the provider teardown and releases the orphan. The sweep runs on startup,
  // committed writes, and deadlines derived from unresolved cleanup.
  //
  // This backstop is independent of the heartbeat scheduler toggle. A leaked
  // provider sandbox costs money whether or not the instance schedules
  // heartbeats, so both the enabled and the disabled path run the sweep. A
  // disabled heartbeat scheduler must not strand a paid sandbox forever.
  //
  // The master pending-cleanup sweep is the single owner of these rows. Its
  // atomic per-attempt claim makes two overlapping sweeps safe, so the enabled
  // path can also run the sweep from the orphaned-run reaper without a second
  // teardown. The delivery coordinator owns pending-work scheduling whether
  // or not the heartbeat scheduler is enabled.
  const environmentLeaseCleanupHeartbeat = accountingHeartbeat;
  const chatCompletionDeliveries = chatCompletionDeliveryService(db as any, environmentLeaseCleanupHeartbeat);
  const connectionDeliveries = connectionIntentDeliveryService(db as any, environmentLeaseCleanupHeartbeat);
  const questionResponseDeliveries = questionResponseDeliveryService(db as any, {
    heartbeat: environmentLeaseCleanupHeartbeat,
    resolveNativeQuestion: (interaction) => deliverNativeQuestionResponse(db as any, interaction),
  });
  const deliveryWork = app.locals.deliveryWork as ReturnType<typeof createDeliveryWorkCoordinator>;
  if (config.nativeHarnessBackupExpirationEnabled) {
    nativeHarnessBackupExpiration.registerCheckpointExpiration(deliveryWork);
  }
  const taskDrainExpiryWork = registerTaskDrainExpiryWork(deliveryWork, () => {
    if (heartbeatSchedulerStopped || isWarmStandby()) return;
    trackHeartbeatSchedulerWork(accountingHeartbeat.resumeQueuedRunsAfterDrain().catch(err => {
      logger.error({ err }, "failed to resume queued work after task drain expiry");
    }));
  });
  server.on("close", () => { void taskDrainExpiryWork.stop(); });
  const executionSchedule = executionControlSchedule(db);
  const workspaceRecoveryRuntime = environmentRuntimeService(db, { pluginWorkerManager });
  const workspaceRecoveryWork = registerWorkspaceRecoveryWork(db, deliveryWork, workspaceRecoveryRuntime,
    accountingHeartbeat.resumeRemoteStopComments, () => !heartbeatSchedulerStopped);
  registerExecutionControlWork(deliveryWork, [
    { queue: DELIVERY_QUEUES.executionFinalization, run: () => reconcileAbandonedExecutionControl(db), next: executionSchedule.finalization },
    { queue: DELIVERY_QUEUES.executionStatus, run: () => deliverExecutionStatuses(db), next: executionSchedule.status },
    { queue: DELIVERY_QUEUES.executionDisposition, run: () => settleUnrecoverableExecutions(db), next: executionSchedule.disposition },
    { queue: DELIVERY_QUEUES.localLoginCleanup, run: () => localAiLoginService(db).reapExpired(), next: executionSchedule.localLogin },
    ...(heartbeat ? [
      { queue: DELIVERY_QUEUES.executionReplacement, run: () => reconcileSafeNativeReplacements(db, new Date(), { verifyStoppedSession: run => verifyStoppedNativeSessionForReplacement(db, run) }), next: executionSchedule.replacement },
      { queue: DELIVERY_QUEUES.executionContinuation, run: () => deliverReconciledExecutions(db, heartbeat.wakeup), next: executionSchedule.continuation },
    ] : []),
  ], () => !heartbeatSchedulerStopped);

  const budgetEnforcementWorker = registerBudgetEnforcementWork(db, deliveryWork, {
    cancelWorkForScope: accountingHeartbeat.cancelBudgetScopeWork,
  });
  const accountingWorker = registerCostAccountingWork(db, deliveryWork, accountingHeartbeat.reconcileCostAccounting);
  server.on("close", accountingWorker.stop);
  skillSourceSync.start(deliveryWork);
  const caseHandoffDeliveries = caseHandoffDeliveryService(db as any, { heartbeat: environmentLeaseCleanupHeartbeat });
  deliveryWork.register(DELIVERY_QUEUES.caseHandoffs, {
    retryMs: 5_000,
    run: signal => caseHandoffDeliveries.sweepPending(signal),
    hasPending: () => caseHandoffDeliveries.hasPending(),
  });
  let unregisterTerminalWorkspaceProbe: (() => void) | undefined;
  let unsubscribeNativeWorkspaceSyncRetention: (() => void) | undefined;
  const fastResponses = app.locals.fastResponses as ReturnType<typeof import("./services/fast-responses.js").fastResponseService>;
  const fastResponseWorker = deliveryWork.register(DELIVERY_QUEUES.fastResponse, {
    retryMs: 100, run: (signal) => fastResponses.sweepPending(signal), hasPending: () => fastResponses.hasPending(),
  });
  const deliveryWorkers = ([
    [DELIVERY_QUEUES.chatCompletion, chatCompletionDeliveries],
    [DELIVERY_QUEUES.connection, connectionDeliveries],
    [DELIVERY_QUEUES.question, questionResponseDeliveries],
    [DELIVERY_QUEUES.toolAction, app.locals.toolActionDeliveries as ReturnType<typeof import("./services/tool-action-delivery.js").toolActionDeliveryService>],
  ] as const).map(([queue, service]) => deliveryWork.register(queue, {
    retryMs: config.heartbeatSchedulerIntervalMs,
    run: () => service.sweepPending(),
    hasPending: () => service.hasPending(),
    ...(queue === DELIVERY_QUEUES.connection ? { nextRunAt: connectionDeliveries.nextRunAt, pausePassiveMaintenance: true } : {}),
  }));
  // Preserve the existing task-scoped activity fast path. Claims in the
  // delivery service arbitrate with the coordinator's startup/recovery sweep.
  const unsubscribeChatCompletions = subscribeAllCompanyLiveEvents(event => {
    if (isIdleTaskDrainActive() || isWarmStandby() || heartbeatSchedulerStopped || event.type !== "activity.logged" ||
      event.payload.action !== "issue.updated" || typeof event.payload.entityId !== "string") return;
    trackHeartbeatSchedulerWork(chatCompletionDeliveries.sweepPending({ companyId: event.companyId, taskId: event.payload.entityId })
      .catch(err => logger.error({ err }, "post-commit chat completion delivery failed")));
  });
  server.on("close", unsubscribeChatCompletions);
  const cleanupInspectionRuntime = environmentRuntimeService(db as any, { pluginWorkerManager });
  const environmentCustomImages = environmentCustomImageService(db as any, { pluginWorkerManager });
  const historicalCleanup = historicalCleanupVerificationService(db as any, {
    inspectLease: lease => cleanupInspectionRuntime.inspectLeaseResource(lease.id),
    inspectSetup: setup => environmentCustomImages.inspectSetupResource(setup),
  });
  const runEnvironmentLeaseCleanupSweep = async (backoffMs: number) => {
    const result = await environmentLeaseCleanupHeartbeat.sweepPendingCleanupLeases({ backoffMs });
    if (result.destroyed > 0 || result.capped > 0) {
      logger.info(result, "environment lease cleanup retried sandbox teardowns");
    }
  };
  const startEnvironmentCleanup = async () => {
    const worker = registerEnvironmentCleanupWork(db, deliveryWork, {
      sweepPending: runEnvironmentLeaseCleanupSweep,
      historical: isCloudManagedInstance() ? historicalCleanup : undefined,
      canRun: () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped,
      minimumSpacingMs: config.heartbeatSchedulerIntervalMs,
    });
    server.on("close", worker.stop);
    await worker.ready;
  };
  const githubConnectionEvents = githubConnectionEventService(db as any, {
    wakeup: environmentLeaseCleanupHeartbeat.wakeup,
  });
  const tools = toolAccessService(db as any, {
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    trustedLocalStdioRuntimeHost: process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
      ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
      ?? null,
  });
  const scheduleGitHubConnectionEventPoll = (forSetup = false) => {
    if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
    const work = githubConnectionEvents.pollOnce({ forSetup })
      .then((result) => {
        if (result.leased > 0 || result.failed > 0) {
          logger.info(result, "GitHub connection event poll completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "GitHub connection event poll failed");
      });
    trackHeartbeatSchedulerWork(work);
    return work;
  };
  server.on("close", registerGitHubBotCloudSetupPoller(db, async () => {
    await scheduleGitHubConnectionEventPoll(true);
  }));
  const scheduleGitHubConnectionContinuitySweep = () => {
    if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
    trackHeartbeatSchedulerWork(tools.sweepGitHubConnectionContinuity()
      .then((result) => {
        if (result.due > 0 || result.failed > 0) {
          logger.info(result, "GitHub connection continuity sweep completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "GitHub connection continuity sweep failed");
      }));
  };

  await timeStartupRecovery("tool_reviews", async () => {
    if (config.heartbeatSchedulerEnabled) {
      await registerToolReviewExpiryWork(deliveryWork, app.locals.toolGateway,
        () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready;
    } else {
      await app.locals.toolGateway.sweepExpiredActionReviews();
    }
    if (config.heartbeatSchedulerEnabled) {
      await registerToolReviewRecoveryWork(deliveryWork, app.locals.toolGateway,
        () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready;
    } else {
      await app.locals.toolGateway.recoverApprovedActionReviews();
    }
    if (config.heartbeatSchedulerEnabled) {
      await registerToolReviewInterruptionWork(deliveryWork, app.locals.toolGateway,
        () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready;
    } else {
      await app.locals.toolGateway.settleInterruptedActionReviews();
    }
    return config.heartbeatSchedulerEnabled
      ? registerToolReviewProjectionWork(deliveryWork, { sweep: app.locals.toolGateway.repairActionReviewProjections, companies: app.locals.toolGateway.actionReviewProjectionCompanies },
        () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready
      : app.locals.toolGateway.repairActionReviewProjections();
  }).catch((err: unknown) => logger.error({ err }, "startup tool review recovery failed"));
  await timeStartupRecovery("gateway_sessions", () => config.heartbeatSchedulerEnabled
    ? registerGatewayCredentialExpiryWork(deliveryWork, app.locals.toolGateway,
      () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready
    : app.locals.toolGateway.cleanupExpiredSessions()).catch((err: unknown) => logger.error({ err }, "startup gateway token cleanup failed"));
  await timeStartupRecovery("delivery_workers", () => Promise.all([budgetEnforcementWorker, accountingWorker, fastResponseWorker, ...deliveryWorkers].map(worker => worker.ready)));
  scheduleGitHubConnectionEventPoll();
  scheduleGitHubConnectionContinuitySweep();

  if (heartbeat) {
    const secretProposals = createSecretProposalsService(db as any);
    const decisionExecutor = decisionService(db as any, decisionServiceOptions);
    const retentionExecutor = decisionRetentionService(db as any, {
      notifyOriginAgent: createDecisionRetentionNotifyOriginAgent(heartbeat.wakeup),
    });
    drainHeartbeatRunsForShutdown = (signal, runIds) => (
      heartbeat.drainRunningRunsForShutdown(signal, new Date(), runIds)
    );
    drainHeartbeatExecutionFinalizers = () =>
      heartbeat.drainActiveRunExecutions();
    prepareHotRestartShutdown = heartbeat.prepareHotRestartShutdown;
    const routines = routineService(db as any, { pluginWorkerManager });
    let nextRoutineStatusReconcile = 0;
    const scheduleRoutineStatusReconcile = () => {
      if (!isCloudManagedInstance() || isWarmStandby() || isIdleTaskDrainActive() || heartbeatSchedulerStopped ||
          Date.now() < nextRoutineStatusReconcile) return;
      nextRoutineStatusReconcile = Date.now() + 5 * 60_000;
      trackHeartbeatSchedulerWork(routines.reconcileExecutionRunStatuses().then(result => {
        if (result.settled > 0) logger.info(result, "reconciled routine execution issue status");
      }).catch(() => logger.warn("routine execution status reconciliation deferred")));
    };
    const statusCards = statusCardService(db as any);
    const issues = issueService(db as any);
    const mergedPullRequestConfirmations = issueThreadInteractionService(db as any, {
      wakeup: heartbeat.wakeup,
    });
    const terminalWorkspaces = executionWorkspaceService(db as any, {
      pluginWorkerManager,
      gitCacheExpirationEnabled: config.gitCacheExpirationEnabled,
      gitBaseExpirationEnabled: config.gitBaseExpirationEnabled,
      gitCacheExpirationDryRun: config.gitCacheExpirationDryRun,
      isolatedSourceRehomeEnabled: config.isolatedSourceRehomeEnabled,
      isolatedSourceRehomeDryRun: config.isolatedSourceRehomeDryRun,
      nestedCloneMigrationEnabled: config.nestedCloneMigrationEnabled,
      nestedCloneMigrationDryRun: config.nestedCloneMigrationDryRun,
      gitRestorePoints: config.gitRestorePointsEnabled ? {
        storage: storageService,
        terminalDelayMs: config.gitRestorePointTerminalDelayDays * 24 * 60 * 60 * 1000,
        idleMs: config.gitRestorePointIdleDays > 0 ? config.gitRestorePointIdleDays * 24 * 60 * 60 * 1000 : null,
        keyDurable: config.storageProvider !== "s3" || Boolean(process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim()),
      } : undefined,
      taskDirectoryRetention: config.taskDirectoryRetentionEnabled ? {
        dryRun: config.taskDirectoryRetentionDryRun,
        terminalDelayMs: config.gitRestorePointTerminalDelayDays * 24 * 60 * 60 * 1000,
        orphanGraceMs: config.taskDirectoryOrphanGraceDays * 24 * 60 * 60 * 1000,
      } : undefined,
      workspaceReaperCooldownDays: config.workspaceReaperCooldownDays,
      workspaceCompactionDelayMs: config.workspaceCompactionDelayHours === null
        ? null
        : config.workspaceCompactionDelayHours * 60 * 60 * 1000,
      terminalWorkspaceInspectionBackoffMs: TERMINAL_WORKSPACE_RETRY_MS,
    });
    const scheduleMergedPullRequestConfirmationSweep = () => {
      if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
      trackHeartbeatSchedulerWork(mergedPullRequestConfirmations
        .sweepMergedPullRequestConfirmations()
        .then((result) => {
          if (result.accepted > 0) {
            logger.info(result, "accepted merge confirmations for merged pull requests");
          }
        })
        .catch((err) => {
          logger.error({ err }, "merged pull-request confirmation sweep failed");
        }));
    };
    const gitRestorePointWorker = registerGitRestorePointWork(deliveryWork, gitRestorePointRetentionService(db as any, {
      storage: storageService,
      retentionDays: config.gitRestorePointRetentionDays,
      beforeExpire: (restorePoint) => markGitRestorePointExpired(db as any, restorePoint),
    }), (result) => {
      if (result.abandoned > 0 || result.expired > 0 || result.orphaned > 0 || result.deleted > 0 || result.failed > 0) {
        logger.info(result, "git restore point retention");
      }
    });
    if (config.nativeWorkspaceSyncRetentionEnabled) {
      unsubscribeNativeWorkspaceSyncRetention = registerNativeWorkspaceSyncRetentionWork(deliveryWork, nativeWorkspaceSyncRetentionService(db as any, {
        retentionDays: config.nativeWorkspaceSyncRetentionDays,
        dryRun: config.nativeWorkspaceSyncRetentionDryRun,
      }), {
        shouldContinue: () => !heartbeatSchedulerStopped && !isIdleTaskDrainActive() && !isWarmStandby(),
        onResult: (result) => {
          if (result.candidates > 0 || result.leftoversRemoved > 0 || result.failed > 0) {
            logger.info({ ...result, dryRun: config.nativeWorkspaceSyncRetentionDryRun }, "native workspace sync retention");
          }
        },
      }).unsubscribe;
    }
    let lastTerminalWorkspaceSkipLogAt = 0;
    const terminalWorkspaceWorker = registerTerminalWorkspaceWork(deliveryWork, {
      ...terminalWorkspaces,
      terminalWorkspaceWorkSettled: (hints) => {
        terminalWorkspaces.terminalWorkspaceWorkSettled?.(hints);
        gitRestorePointWorker.issuesChanged();
      },
      sweepTerminalWorkspaces: async (limit, signal, options) => {
        const result = await terminalWorkspaces.sweepTerminalWorkspaces(limit, signal, options);
        if (result.archived > 0 || result.cleanupFailed > 0 || result.compacted > 0 || result.compactionFailed > 0) {
          logger.info(result, "terminal issue workspace reaper changed workspace state");
        } else if (result.checked > 0 && Date.now() - lastTerminalWorkspaceSkipLogAt >= 10 * 60 * 1000) {
          lastTerminalWorkspaceSkipLogAt = Date.now();
          logger.info(result, "terminal issue workspace reaper skipped all candidates");
        }
        return result;
      },
    }, () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped);
    unregisterTerminalWorkspaceProbe = registerIdleLocalWorkProbe(() => terminalWorkspaceWorker.hasUnrecoveredWork() ? "present" : "none");
    await terminalWorkspaceWorker.ready;

    const adapterLoginReaper = createDeviceLoginReaper({
      store: createDbAdapterAuthSessionStore(db as any),
      runtime: createProductionLoginSessionReaperRuntime({
        db: db as any,
        environmentRuntime: environmentRuntimeService(db as any, { pluginWorkerManager }),
      }),
    });
    const logAdapterLoginReaperResult = (
      result: Awaited<ReturnType<typeof adapterLoginReaper.sweep>>,
    ) => {
      if (
        result.expiredTimedOut > 0 ||
        result.cleanupCleared > 0 ||
        result.orphanLeasesDeleted > 0 ||
        result.cleanupPendingRemaining > 0
      ) {
        logger.info(result, "adapter login reaper swept login sessions");
      }
    };

    const setupTokenReaper = createProductionSetupTokenReaper({
      db: db as any,
      environmentRuntime: environmentRuntimeService(db as any, { pluginWorkerManager }),
      log: (line) => logger.info(line),
    });
    const logSetupTokenReaperResult = (
      result: Awaited<ReturnType<typeof setupTokenReaper.sweep>>,
    ) => {
      if (result.released > 0 || result.failed > 0) {
        logger.info(result, "setup-token login reaper released leases");
      }
    };

    const worktreeRunExecutionActivation = await resolveWorktreeRunExecutionActivationState({
      getExperimental: () => instanceSettingsService(db).getExperimental(),
    });
    logger.info(
      {
        state: worktreeRunExecutionActivation.armed ? "armed" : "disarmed",
        cutoff: worktreeRunExecutionActivation.cutoff,
      },
      "worktree run-execution cutoff state",
    );
    const heartbeatSchedulingSuppression = await heartbeat.resolveSchedulingSuppression();

    // Reap orphaned runs before timer ticks start so wakeups cannot coalesce
    // into a dead "running" row during startup recovery.
    if (heartbeatSchedulingSuppression.suppressed) {
      logger.warn(
        { reason: heartbeatSchedulingSuppression.reason },
        "heartbeat scheduling suppressed for this runtime instance",
      );
    } else {
      const startupHeartbeatRecovery = (async () => {
        // Legacy remote recovery releases sandbox leases. Wait for provider
        // workers before cleanup or retry admission, including unmanaged installs.
        await timeStartupRecovery("plugin_workers", () => app.locals.bundledPluginsStartup);
        try {
          const nativeRecovery = await timeStartupRecovery("native_recovery", () => heartbeat.recoverNativeRunsAfterRestart());
          if (nativeRecovery.dispositions.length > 0) {
            logger.info(
              {
                restartKind: nativeRecovery.restartKind,
                claims: nativeRecovery.claims.map((claim) => ({
                  runId: claim.runId,
                  disposition: claim.kind,
                  controllerGeneration: claim.controllerGeneration,
                })),
                awaitingEvidenceRunIds:
                  nativeRecovery.awaitingEvidenceRunIds,
                blockedRunIds: nativeRecovery.blockedRunIds,
              },
              "startup native runner restart recovery classified",
            );
          }
        } catch (err) {
          logger.error(
            { err },
            "startup native runner restart recovery failed closed",
          );
          throw err;
        }
        try {
          const hotRestart = await timeStartupRecovery("hot_restart", () => heartbeat.reconcileHotRestartAdoption());
          if (hotRestart.mode === "reported") {
            logger.info(
              hotRestart,
              "startup hot-restart adoption reconciliation complete",
            );
          }
        } catch (err) {
          logger.error(
            { err },
            "startup hot-restart adoption reconciliation failed - orphan reaper will serve as degraded backstop",
          );
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const result = await timeStartupRecovery("orphan_reaping", () => heartbeat.reapOrphanedRuns());
            logger.info(
              { reaped: result.reaped, runIds: result.runIds },
              "startup reap of orphaned heartbeat runs complete",
            );
            break;
          } catch (err) {
            if (attempt < 2) {
              logger.warn({ err, attempt }, "startup reap failed, retrying");
            } else {
              logger.error(
                { err },
                "startup reap of orphaned heartbeat runs failed after retry - periodic reaper will serve as degraded backstop",
              );
            }
          }
        }

        const promotion = await timeStartupRecovery("scheduled_retries", () => heartbeat.promoteDueScheduledRetries());
        await timeStartupRecovery("queued_runs", () => heartbeat.resumeQueuedRuns());
        const recoveredGoalActions = await timeStartupRecovery("goal_actions", () => heartbeat.recoverPendingSessionGoalActions());
        if (
          recoveredGoalActions.enqueued > 0 ||
          recoveredGoalActions.invalid > 0
        ) {
          logger.warn(
            recoveredGoalActions,
            "startup session-goal action outbox recovery reconciled pending controls",
          );
        }
        const recoveredGoals = await timeStartupRecovery("active_goals", () => heartbeat.recoverActiveSessionGoals());
        if (recoveredGoals.enqueued > 0) {
          logger.warn(
            recoveredGoals,
            "startup session-goal recovery resumed durable agent goals",
          );
        }
        const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
        if (
          promotion.promoted > 0 ||
          reconciled.assignmentDispatched > 0 ||
          reconciled.dispatchRequeued > 0 ||
          reconciled.continuationRequeued > 0 ||
          reconciled.successfulRunHandoffEscalated > 0 ||
          reconciled.successfulRunHandoffRetried > 0 ||
          reconciled.escalated > 0
        ) {
          logger.warn(
            { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
            "startup heartbeat recovery changed assigned issue state",
          );
        }

        const dependencyWakesReconciled = await heartbeat.reconcileResolvedDependencyWakes();
        if (dependencyWakesReconciled.healed > 0) {
          logger.warn(
            { ...dependencyWakesReconciled },
            "startup dependency-wake reconciliation restored task execution paths",
          );
        }

        const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
        reportIncompleteWatchdogScans(taskWatchdogsReconciled, "startup");
        if (taskWatchdogsReconciled.triggered > 0) {
          logger.warn(
            { ...taskWatchdogsReconciled },
            "startup task-watchdog reconciliation triggered watchdog work",
          );
        }

        const scanned = await heartbeat.scanSilentActiveRuns();
        if (scanned.created > 0 || scanned.escalated > 0) {
          logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
        }

        const swept = await heartbeat.sweepStaleIssueLocks();
        if (swept.cleared > 0) {
          logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
        }
      })().catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
        throw err;
      });
      trackHeartbeatSchedulerWork(startupHeartbeatRecovery);
      await startupHeartbeatRecovery;
    }

    const runRetentionSweep = async () => {
      const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
      let archived = 0;
      for (const company of activeCompanies) {
        // Cursor pagination rebuilds the whole feed for every page; one
        // unscoped all-items build keeps this sweep at a single feed build
        // per company per tick.
        const page = await attentionService(db as any).list(company.id, {
          includeDismissed: true,
          excludeSources: ["approval", "join_request"],
          all: true,
          allowUnscopedAll: true,
        });
        archived += await retentionExecutor.autoArchive({ companyId: company.id, items: page.items });
      }
      return { archived };
    };
    // Startup housekeeping: provider and connection sweeps that every timer tick
    // repeats and that neither serving requests nor run recovery depends on.
    // Readiness does not wait for it. It is tracked as scheduler work, so idle
    // sleep and shutdown wait for it. Each step logs its own failure and the
    // next step still runs. The scheduler interval starts after it, so the login
    // reapers and the lease cleanup still finish before the first timer tick.
    const runStartupHousekeeping = async () => {
      const step = (name: string, work: () => Promise<unknown>) =>
        work().catch((err: unknown) => {
          logger.error({ err, startupStep: name }, "startup housekeeping step failed");
        });
      await step("secret_proposal_expiry", () => registerSecretProposalExpiryWork(deliveryWork, secretProposals,
        () => !isIdleTaskDrainActive() && !heartbeatSchedulerStopped && !isWarmStandby()).ready);
      await step("custom_image_setup_cleanup", () => registerCustomImageCleanupWork(deliveryWork, environmentCustomImages,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped,
        config.heartbeatSchedulerIntervalMs).ready);
      await step("tool_connection_health", () => registerToolConnectionHealthWork(deliveryWork, tools.scheduledHealth,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("decision_continuation_worker", () => registerDecisionContinuationWork(deliveryWork, decisionExecutor,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("decision_expiry_worker", () => registerDecisionExpiryWork(deliveryWork, decisionExecutor,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("decision_effect_recovery_worker", () => registerDecisionEffectRecoveryWork(deliveryWork, decisionExecutor,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("decision_target_worker", () => registerDecisionTargetWork(deliveryWork, decisionExecutor,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      const loginSchedule = loginCleanupSchedule(db, config.heartbeatSchedulerIntervalMs);
      await step("login_cleanup_workers", () => registerLoginCleanupWork(deliveryWork, [
        { queue: DELIVERY_QUEUES.adapterLoginCleanup, run: () => adapterLoginReaper.sweep().then(logAdapterLoginReaperResult), next: loginSchedule.adapter },
        { queue: DELIVERY_QUEUES.setupTokenCleanup, run: () => setupTokenReaper.sweep().then(logSetupTokenReaperResult), next: loginSchedule.setupToken },
      ], () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped, config.heartbeatSchedulerIntervalMs).ready);
      // Retry any orphan sandbox teardown left by a failed acquire before a
      // server restart, so a leaked sandbox does not stay allocated.
      await step("environment_lease_cleanup", startEnvironmentCleanup);
      await step("archive_notification_worker", () => registerDecisionArchiveDeliveryWork(deliveryWork, retentionExecutor,
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("approval_queue_seeding", () => registerApprovalQueueSeedingWork(deliveryWork, approvalQueueSeedingService(db as any),
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("approval_retention", () => registerApprovalRetentionWork(deliveryWork, approvalRetentionService(db as any),
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("join_request_retention", () => registerJoinRequestRetentionWork(deliveryWork, joinRequestRetentionService(db as any),
        () => !isIdleTaskDrainActive() && !isWarmStandby() && !heartbeatSchedulerStopped).ready);
      await step("retention_sweep", runRetentionSweep);
    };

    const createHeartbeatSchedulerTick = (scheduled: ReturnType<typeof registerScheduledWork>) => () => {
      // Track the outer async callback as well as the work it starts. Shutdown
      // can then wait through an already-running suppression check before it
      // captures the authoritative set of running heartbeat rows.
      trackHeartbeatSchedulerWork((async () => {
        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        scheduleRoutineStatusReconcile();
        trackHeartbeatSchedulerWork(runRetentionSweep().catch((err: unknown) => {
          logger.error({ err }, "decision retention sweep failed");
        }));
        const sweptRuntimeStatuses = heartbeat.sweepExpiredRuntimeStatuses();
        if (sweptRuntimeStatuses > 0) {
          logger.info(
            { swept: sweptRuntimeStatuses },
            "heartbeat runtime-status sweeper cleared expired entries",
          );
        }

        scheduled.timers.wake();

        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        scheduleExternalObjectRefreshSweep(new Date());

        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        scheduleMergedPullRequestConfirmationSweep();
        scheduleGitHubConnectionEventPoll();
        scheduleGitHubConnectionContinuitySweep();

        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        scheduled.routines.wake();

        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        trackHeartbeatSchedulerWork((async () => {
          const experimental = await instanceSettingsService(db).getExperimental();
          if (experimental.enableStatusCards !== true) return;
          const result = await statusCards.tickDueStatusCards(new Date());
          await Promise.all(result.enqueued.map(async ({ cardId, generatingIssue }) => {
            try {
              await queueIssueAssignmentWakeup({
                heartbeat,
                issue: generatingIssue,
                reason: "status_card_update_assigned",
                mutation: "status_card.scheduler_update_requested",
                contextSource: "status_card_scheduler",
                requestedByActorType: "system",
                taskKey: `status-card:${cardId}`,
                rethrowOnError: true,
              });
            } catch (err) {
              await issues.update(generatingIssue.id, { status: "cancelled" });
              throw err;
            }
          }));
          if (result.evaluated > 0 || result.enqueued.length > 0) {
            logger.info({ evaluated: result.evaluated, enqueued: result.enqueued.length }, "status-card scheduler tick complete");
          }
        })().catch((err) => {
          logger.error({ err }, "status-card scheduler tick failed");
        }));

        if (isIdleTaskDrainActive() || heartbeatSchedulerStopped) return;
        if (!(await heartbeat.resolveSchedulingSuppression()).suppressed) {
          // Periodically reap orphaned runs (5-min staleness threshold) and make sure
          // persisted queued work is still being driven forward.
          runPeriodicRecovery(() => heartbeat
            .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
            .then(() => heartbeat.promoteDueScheduledRetries())
            .then(async (promotion) => {
              await heartbeat.resumeQueuedRuns();
              const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
              if (
                promotion.promoted > 0 ||
                reconciled.assignmentDispatched > 0 ||
                reconciled.dispatchRequeued > 0 ||
                reconciled.continuationRequeued > 0 ||
                reconciled.successfulRunHandoffEscalated > 0 ||
                reconciled.successfulRunHandoffRetried > 0 ||
                reconciled.escalated > 0
              ) {
                logger.warn(
                  { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
                  "periodic heartbeat recovery changed assigned issue state",
                );
              }
            })
            .then(async () => {
              const reconciled = await heartbeat.reconcileResolvedDependencyWakes();
              if (reconciled.healed > 0) {
                logger.warn({ ...reconciled }, "periodic dependency-wake reconciliation restored task execution paths");
              }
            })
            .then(async () => {
              const reconciled = await heartbeat.reconcileTaskWatchdogs();
              reportIncompleteWatchdogScans(reconciled, "periodic");
              if (reconciled.triggered > 0) {
                logger.warn({ ...reconciled }, "periodic task-watchdog reconciliation triggered watchdog work");
              }
            })
            .then(async () => {
              const scanned = await heartbeat.scanSilentActiveRuns();
              if (scanned.created > 0 || scanned.escalated > 0) {
                logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
              }
            })
            .then(async () => {
              const swept = await heartbeat.sweepStaleIssueLocks();
              if (swept.cleared > 0) {
                logger.warn({ ...swept }, "periodic stale-lock sweeper cleared issue locks");
              }
            })
            .catch((err) => {
              logger.error({ err }, "periodic heartbeat recovery failed");
            }));
        }
      })().catch((err) => {
        logger.error({ err }, "heartbeat scheduler tick failed");
      }));
    };
    const startHeartbeatScheduler = () => {
      const scheduled = registerScheduledWork(deliveryWork, db, {
        retryMs: config.heartbeatSchedulerIntervalMs,
        tickTimers: async () => {
          if ((await heartbeat.resolveSchedulingSuppression()).suppressed) return;
          const result = await heartbeat.tickTimers(new Date());
          if (result.enqueued > 0) logger.info({ ...result }, "heartbeat timer tick enqueued runs");
        },
        tickRoutines: () => routines.tickScheduledTriggers(new Date()).then(result => {
          if (result.triggered > 0) logger.info({ ...result }, "routine scheduler tick enqueued runs");
        }),
      });
      trackHeartbeatSchedulerWork(Promise.all([scheduled.timers.ready, scheduled.routines.ready]));
      startHeartbeatSchedulerInterval(createHeartbeatSchedulerTick(scheduled));
    };
    trackHeartbeatSchedulerWork(runStartupHousekeeping().then(() => {
      if (!heartbeatSchedulerStopped) startHeartbeatScheduler();
    }));
  } else {
    // The heartbeat scheduler is disabled, but the orphan-sandbox cleanup sweep
    // is still required. A failed acquire can leak a paid provider sandbox, so
    // this path registers the same startup recovery and pending-work deadlines
    // as the enabled path.
    await startEnvironmentCleanup();
    startHeartbeatSchedulerInterval(() => {
      scheduleExternalObjectRefreshSweep(new Date());
      scheduleGitHubConnectionEventPoll();
      scheduleGitHubConnectionContinuitySweep();
    });
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    // The final pre-sleep dump remains on the volume throughout sleep. Take
    // a fresh backup on restart before idle eligibility is enabled, including
    // after rollback of the opt-in flag. Failure retains the marker for retry.
    if (!isWarmStandby() && existsSync(idleBackupWakeMarker(config.databaseBackupDir))) {
      await runServerDatabaseBackup("scheduled").catch(() => {});
    }
    setInterval(() => {
      if (isWarmStandby() || isIdleTaskDrainActive()) return;
      void runServerDatabaseBackup("scheduled").catch(() => {
        // runServerDatabaseBackup already logs the failure with context.
      });
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

  // Reconcile the agent-creation picker to the declaratively-configured adapter
  // set (PAPERCLIP_ADAPTERS). Must run after external adapters are loaded so the
  // known-adapter list is complete. Fail loud on misconfig (a declared adapter
  // with no implementation), consistent with the execution-policy bootstrap:
  // log the structured error, then rethrow to fail startup.
  try {
    reconcileAdapterAvailability(parseAdapterRegistryEnv());
  } catch (err) {
    logger.error({ err }, "failed to reconcile adapter availability from PAPERCLIP_ADAPTERS");
    throw err;
  }

  markIdleStartupComplete({ scheduledBackups: config.databaseBackupEnabled });
  setStartupRecoveryPhase("ready");
  logger.info(`Server startup recovery complete on ${config.host}:${listenPort}`);
  void systemdNotify(["--ready", `--status=Listening on ${config.host}:${listenPort}`]).then((notified) => {
    if (notified) logger.info("Notified systemd that Paperclip is ready");
  });
  if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
    const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const url = `http://${openHost}:${listenPort}`;
    void import("open")
      .then((mod) => mod.default(url))
      .then(() => {
        logger.info(`Opened browser at ${url}`);
      })
      .catch((err) => {
        logger.warn({ err, url }, "Failed to open browser on startup");
      });
  }
  printStartupBanner({
    bind: config.bind,
    host: config.host,
    deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: requestedListenPort,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
  });
  const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
  if (boardClaimUrl) {
    const red = "\x1b[41m\x1b[30m";
    const yellow = "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      [
        `${red}  BOARD CLAIM REQUIRED  ${reset}`,
        `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
        `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
        `${yellow}${boardClaimUrl}${reset}`,
        `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
      ].join("\n"),
    );
  }
  
  const shutdown = async (
    signal: "SIGINT" | "SIGTERM",
    exitProcess: boolean,
  ) => {
    await systemdNotify(["--stopping", `--status=Stopping after ${signal}`]);
    heartbeatSchedulerStopped = true;
    await taskDrainExpiryWork.stop();
    clearInterval(skillVersionRetentionInterval);
    clearTimeout(skillVersionRetentionStartup);
    clearTimeout(skillVersionRetentionContinuation);
    clearInterval(nativeHarnessBackupExpirationInterval);
    clearTimeout(nativeHarnessBackupExpirationStartup);
    clearTimeout(nativeHarnessBackupExpirationContinuation);
    unsubscribeNativeRunnerEvidence();
    await skillVersionRetention.dispose();
    await skillSourceSync.stop();
    unsubscribeChatCompletions();
    await deliveryWork.stop();
    await workspaceRecoveryWork.stop();
    unregisterTerminalWorkspaceProbe?.();
    unsubscribeNativeWorkspaceSyncRetention?.();
    if (heartbeatSchedulerInterval) {
      clearInterval(heartbeatSchedulerInterval);
      heartbeatSchedulerInterval = null;
    }

    const heartbeatShutdown = await coordinateHeartbeatSchedulerShutdown({
      signal,
      prepareHotRestartShutdown,
      waitForHeartbeatSchedulerIdle,
    });
    const skipHeartbeatDrain = heartbeatShutdown.hotRestart?.skipDrain === true;
    const selectiveDrainRunIds = heartbeatShutdown.hotRestart?.drainRunIds ?? null;
    if (skipHeartbeatDrain) {
      logger.info(
        { signal, hotRestart: heartbeatShutdown.hotRestart },
        "hot-restart shutdown prepared after scheduler quiescence; skipping graceful run drain",
      );
    } else if (heartbeatShutdown.preparationError) {
      logger.error(
        { err: heartbeatShutdown.preparationError, signal },
        "hot-restart shutdown preparation failed; falling back to graceful heartbeat run drain",
      );
    }

    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      telemetryClient.stop();
      await telemetryClient.flush();
    }

    if (!skipHeartbeatDrain && drainHeartbeatRunsForShutdown) {
      try {
        const drain = await drainHeartbeatRunsForShutdown(signal, selectiveDrainRunIds);
        logger.info({ signal, drain }, "graceful heartbeat run drain complete");
      } catch (err) {
        logger.error({ err, signal }, "graceful heartbeat run drain failed");
      }
    }

    if (!skipHeartbeatDrain) {
      await drainRunExecutionFinalizersForShutdown({
        signal,
        drain: drainHeartbeatExecutionFinalizers,
        timeoutMs: 30_000,
        log: logger,
      });
    }

    // Whatever the drain did not finalize (timed-out runs, the hot-restart
    // skip path) still has a local-only tail when the in-flight run-log
    // mirror is enabled; upload those tails now so an orderly restart
    // never loses run output. No-op when the mirror is off.
    try {
      await flushInFlightRunLogMirrors();
    } catch (err) {
      logger.error({ err, signal }, "run-log in-flight mirror flush failed");
    }

    const appShutdown = (app as { locals?: { paperclipShutdown?: () => Promise<void> } }).locals
      ?.paperclipShutdown;
    const stopEmbeddedPostgres = embeddedPostgres && embeddedPostgresStartedByThisProcess
      ? () => embeddedPostgresSupervisor?.shutdown() ?? embeddedPostgres!.stop()
      : null;

    // Await the ordered application teardown before the process exits. A live
    // setup-token login session must stop and release its sandbox lease before
    // the database and the provider stop, so an orderly shutdown never leaves a
    // sandbox lease or confidential login state alive past the process exit.
    // The HTTP listener closes first, while every service is still up, so a
    // request in flight is drained against a working server and none reaches
    // a route once the pool is gone; the programmatic close below then finds
    // the listener already closed and skips.
    await finalizeServerShutdown({
      signal,
      shutdownAppServices: appShutdown,
      closeHttpListener: () =>
        closeHttpListenerForShutdown({ server, signal, log: logger }),
      drainPendingRunFailureReports: waitForPendingRunFailureReports,
      // Mark the pool as ending before `sql.end()` rejects the first query,
      // so the error handler recognizes a request that outlived the drain.
      closeDatabase: () => {
        (app.locals as { paperclipDatabaseClosing?: boolean }).paperclipDatabaseClosing = true;
        return closeDatabaseClients();
      },
      stopEmbeddedPostgres,
      shutdownInstrumentation,
      shutdownSentry,
      log: logger,
    });

    if (!exitProcess && server.listening) {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    }

    if (exitProcess) process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT", true);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", true);
  });

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
    shutdown: (signal = "SIGTERM") => shutdown(signal, false),
  };
  } catch (error) {
    if (startupListenerBound) {
      await new Promise<void>((resolveClose) => {
        try {
          server.close((closeError?: Error) => {
            if (
              closeError &&
              (closeError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ) {
              logger.error(
                { err: closeError },
                "failed to close HTTP listener after startup failure",
              );
            }
            resolveClose();
          });
        } catch (closeError) {
          logger.error(
            { err: closeError },
            "failed to close HTTP listener after startup failure",
          );
          resolveClose();
        }
      });
    }
    throw error;
  }
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch(async (err) => {
    logger.error({ err }, "Paperclip server failed to start");
    // Supervised-transient refusals in managed-cloud deployments are an
    // expected provisioning phase (see startup-refusals.ts) — they log
    // and exit nonzero but do not page Sentry.
    if (shouldReportStartupFailure(err)) {
      captureException(err);
    }
    await shutdownSentry();
    process.exit(1);
  });
}
