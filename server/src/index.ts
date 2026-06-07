/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Express, Request as ExpressRequest, RequestHandler } from "express";
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
} from "@valadrien-os/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  backfillPrincipalAccessCompatibility,
  heartbeatService,
  instanceSettingsService,
  reconcileCloudUpstreamRunsOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
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

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
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
  app: Express;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

/**
 * Bound a cold-start step so a hanging dependency can't pin a serverless cold boot to
 * the function's max duration (we observed a 300s hang → 504). On timeout OR error it
 * logs and CONTINUES — the control plane starts (degraded) rather than wedging. Used
 * only on serverless; the persistent worker awaits these fully.
 */
async function boundColdStartStep(label: string, ms: number, run: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        { coldStartStep: label, timeoutMs: ms },
        `cold-start step '${label}' exceeded ${ms}ms — continuing (runs again next boot / on the worker)`,
      );
      resolve();
    }, ms);
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(run)
        .then(() => undefined)
        .catch((err) => {
          logger.warn({ coldStartStep: label, err }, `cold-start step '${label}' failed — continuing`);
        }),
      timed,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startServer(): Promise<StartedServer> {
  // --- cold-start boot timing -------------------------------------------------
  // One-shot per process: startServer runs exactly once per (cold) instance, so
  // these marks fire once and partition the cold start into named segments.
  // Read them in the Vercel function runtime logs after a cold hit to find which
  // phase owns the ~7s serverless cold start. Gated to Vercel (or an explicit
  // flag) so the always-on Railway worker emits no extra log noise.
  const __bootTimingEnabled =
    !!process.env.VERCEL || process.env.VALADRIEN_OS_BOOT_TIMING === "true";
  const __bootStart = performance.now();
  let __bootLast = __bootStart;
  const bootMark = (phase: string): void => {
    if (!__bootTimingEnabled) return;
    const now = performance.now();
    const phaseMs = Math.round(now - __bootLast);
    const sinceStartMs = Math.round(now - __bootStart);
    // console.log (not logger.info): the prod pino level filters out info, which
    // silently dropped these marks on the first measurement pass. console.log is
    // captured by Vercel regardless of log level, matching the module-import mark.
    console.log(
      `boot-timing: ${phase} (+${phaseMs}ms, ${sinceStartMs}ms total) ` +
        JSON.stringify({ bootPhase: phase, phaseMs, sinceStartMs }),
    );
    __bootLast = now;
  };

  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.VALADRIEN_OS_SECRETS_PROVIDER === undefined) {
    process.env.VALADRIEN_OS_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.VALADRIEN_OS_SECRETS_STRICT_MODE === undefined) {
    process.env.VALADRIEN_OS_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.VALADRIEN_OS_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.VALADRIEN_OS_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
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
    if (process.env.VALADRIEN_OS_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.VALADRIEN_OS_MIGRATION_PROMPT === "never") return false;
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
            "Refusing to start against a stale schema. Run pnpm db:migrate or set VALADRIEN_OS_MIGRATION_AUTO_APPLY=true.",
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
          "Refusing to start against a stale schema. Run pnpm db:migrate or set VALADRIEN_OS_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
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

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
      if (!parsed.port) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@valadrien-os.local";
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
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  assertCloudDatabaseContract();
  if (config.databaseUrl) {
    // The serverless control plane (Vercel) must NOT run/inspect migrations or open a
    // second pool to the migration URL (Supabase SESSION pooler, :5432). Every cold start
    // would otherwise burn scarce session-pooler clients (EMAXCONNSESSION) and add boot
    // latency. Migrations are owned by the persistent worker; skip here and use a single
    // pool against the (transaction-pooler) runtime URL.
    const runMigrations = !process.env.VERCEL;
    const migrationUrl = config.databaseMigrationUrl ?? config.databaseUrl;
    if (runMigrations) {
      migrationSummary = await ensureMigrations(migrationUrl, "PostgreSQL");
    } else {
      migrationSummary = "skipped";
    }

    db = createDb(config.databaseUrl);
    pluginMigrationDb =
      runMigrations && config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
    // Log the resolved DB endpoint (host:port only — never credentials) so we can
    // confirm which Supabase pooler the serverless control plane actually connects to
    // (:6543 transaction pooler for serverless vs :5432 session pooler).
    let dbEndpoint = "unknown";
    try {
      const u = new URL(config.databaseUrl);
      dbEndpoint = `${u.hostname}:${u.port || "(default)"}`;
    } catch {
      const at = config.databaseUrl.lastIndexOf("@");
      dbEndpoint = at >= 0 ? config.databaseUrl.slice(at + 1).split(/[/?]/)[0] : "unparseable";
    }
    logger.info({ dbEndpoint }, "Using external PostgreSQL via DATABASE_URL/config");
    console.log(`boot-db: connecting to ${dbEndpoint}`);
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
    bootMark("db+migrations");
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
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
    const verboseEmbeddedPostgresLogs = process.env.VALADRIEN_OS_EMBEDDED_POSTGRES_VERBOSE === "true";
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
      const configuredAdminConnectionString = `postgres://valadrien_os:valadrien_os@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "valadrien_os");
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
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "valadrien_os",
          password: "valadrien_os",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

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
      }
    }
  
    const embeddedAdminConnectionString = `postgres://valadrien_os:valadrien_os@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "valadrien_os");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: valadrien-os");
    }
  
    const embeddedConnectionString = `postgres://valadrien_os:valadrien_os@127.0.0.1:${port}/valadrien_os`;
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
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
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
  // One-time data backfill — owned by the persistent worker, NOT the serverless control
  // plane. Running it on every Vercel cold boot adds DB load and risks pinning the cold
  // start (it was the 300s-hang / EMAXCONN source). Skip on Vercel, like migrations.
  if (!process.env.VERCEL) {
    const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
    if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
      logger.info(accessBackfill, "Backfilled principal access compatibility records");
    }
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
  bootMark("auth");

  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const backupSettingsSvc = instanceSettingsService(db);
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
        filenamePrefix: "valadrien-os",
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
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
  bootMark("app-built");

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
  const configuredApiUrl = process.env.VALADRIEN_OS_API_URL?.trim() || runtimeApiUrl;
  const runtimeApiCandidates = buildRuntimeApiCandidateUrls({
    preferredApiUrl: configuredApiUrl,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.VALADRIEN_OS_LISTEN_HOST = runtimeListenHost;
  process.env.VALADRIEN_OS_LISTEN_PORT = String(listenPort);
  process.env.VALADRIEN_OS_RUNTIME_API_URL = runtimeApiUrl;
  process.env.VALADRIEN_OS_RUNTIME_API_CANDIDATES_JSON = JSON.stringify(runtimeApiCandidates);
  process.env.VALADRIEN_OS_API_URL = configuredApiUrl;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  void reconcileCloudUpstreamRunsOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled cloud upstream runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of cloud upstream runs failed");
    });
  
  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any, { pluginWorkerManager });
    const routines = routineService(db as any, { pluginWorkerManager });
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
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
            "startup heartbeat recovery changed assigned issue state",
          );
        }
      })
      .then(async () => {
        const reconciled = await heartbeat.reconcileIssueGraphLiveness();
        if (reconciled.escalationsCreated > 0) {
          logger.warn({ ...reconciled }, "startup issue-graph liveness reconciliation created escalations");
        }
      })
      .then(async () => {
        const scanned = await heartbeat.scanSilentActiveRuns();
        if (scanned.created > 0 || scanned.escalated > 0) {
          logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
        }
      })
      .then(async () => {
        const reviewed = await heartbeat.reconcileProductivityReviews();
        if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
          logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
    setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      void routines
        .tickScheduledTriggers(new Date())
        .then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "routine scheduler tick failed");
        });
  
      // Periodically reap orphaned runs (5-min staleness threshold) and make sure
      // persisted queued work is still being driven forward.
      void heartbeat
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
          if (reconciled.escalationsCreated > 0) {
            logger.warn({ ...reconciled }, "periodic issue-graph liveness reconciliation created escalations");
          }
        })
        .then(async () => {
          const scanned = await heartbeat.scanSilentActiveRuns();
          if (scanned.created > 0 || scanned.escalated > 0) {
            logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
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
        });
    }, config.heartbeatSchedulerIntervalMs);
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
  if (process.env.VERCEL) {
    // Bound it: if an external adapter import stalls, a serverless cold boot must not
    // hang to the function's max duration (→ 504). Continue after the bound; adapter
    // type validation may briefly miss a slow external type, which is recoverable.
    await boundColdStartStep("waitForExternalAdapters", 15_000, () => waitForExternalAdapters());
  } else {
    await waitForExternalAdapters();
  }
  bootMark("adapters");

  const startedServer = {
    server,
    app,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
  bootMark("ready");

  if (process.env.VERCEL) {
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
    logger.info("Running on Vercel — Express app exported without listen()");
    return startedServer;
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
      if (process.env.VALADRIEN_OS_OPEN_ON_LISTEN === "true") {
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
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      const appShutdown = (app as { locals?: { valadrienOsShutdown?: () => void } }).locals?.valadrienOsShutdown;
      appShutdown?.();

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return startedServer;
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
    logger.error({ err }, "ValadrienOs server failed to start");
    process.exit(1);
  });
}
