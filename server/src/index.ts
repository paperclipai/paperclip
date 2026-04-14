/// <reference path="./types/express.d.ts" />
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  ensureRuntimeRole,
  buildRuntimeConnectionString,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { accessService, agentService } from "./services/index.js";
import { heartbeatService } from "./services/index.js";
import { AGENT_ROLE_DEFAULT_PERMISSIONS } from "@paperclipai/shared";
import { initTelegramNotifications, notifyOps } from "./services/telegram.js";
import { checkSchemaIntegrity } from "./routes/health.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";

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
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const config = loadConfig();
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
  | "applied (pending migrations)"
  | "pending migrations skipped";

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

const RUNTIME_DB_ROLE_NAME = "paperclip_runtime";

/**
 * After migrations have been applied with the migration (superuser) credentials,
 * provision the restricted `paperclip_runtime` PostgreSQL role and return a
 * connection string scoped to it. Subsequent application code should use the
 * returned URL so that runtime queries cannot perform DDL (CREATE/DROP/ALTER/
 * TRUNCATE) on the schema even if the application is exploited.
 *
 * Throws if `PAPERCLIP_RUNTIME_DB_PASSWORD` is not set, so misconfigured
 * production deployments fail loudly instead of silently running as superuser.
 */
async function provisionRuntimeRoleAndUrl(
  migrationConnectionString: string,
): Promise<string> {
  const runtimePassword = process.env.PAPERCLIP_RUNTIME_DB_PASSWORD?.trim();
  if (!runtimePassword) {
    throw new Error(
      "PAPERCLIP_RUNTIME_DB_PASSWORD is not set. The Paperclip server requires a " +
        "dedicated low-privilege PostgreSQL role for runtime queries; the migration " +
        "credentials are only used at startup to apply schema changes. Set " +
        "PAPERCLIP_RUNTIME_DB_PASSWORD to a strong, randomly-generated password " +
        "(it does not need to match any existing role — the server will create or " +
        `update the "${RUNTIME_DB_ROLE_NAME}" role on startup).`,
    );
  }

  const { roleName, databaseName } = await ensureRuntimeRole(migrationConnectionString, {
    roleName: RUNTIME_DB_ROLE_NAME,
    password: runtimePassword,
  });
  logger.info(
    { roleName, database: databaseName },
    "Provisioned restricted runtime PostgreSQL role (DML-only on public schema)",
  );

  return buildRuntimeConnectionString(migrationConnectionString, roleName, runtimePassword);
}

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
      logger.warn(
        { pendingMigrations: state.pendingMigrations },
        `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
      );
      return "pending migrations skipped";
    }

    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }

  const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
  if (!apply) {
    logger.warn(
      { pendingMigrations: state.pendingMigrations },
      `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
    );
    return "pending migrations skipped";
  }

  logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
  await applyPendingMigrations(connectionString);
  return "applied (pending migrations)";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
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
let embeddedPostgres: EmbeddedPostgresInstance | null = null;
let embeddedPostgresStartedByThisProcess = false;
let migrationSummary: MigrationSummary = "skipped";
// Connection string used by privileged maintenance jobs that need full read
// access to all schemas/sequences (e.g. database backups). Always points at
// the migration role, never the restricted runtime role.
let backupDatabaseConnectionString: string;
let startupDbInfo:
  | { mode: "external-postgres"; connectionString: string }
  | { mode: "embedded-postgres"; dataDir: string; port: number };
if (config.databaseUrl) {
  migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");

  // Migrations are now applied with the migration credentials (which must be a
  // superuser / DDL-capable role). Provision the restricted runtime role and
  // open the application pool against it so any subsequent query — including
  // ones built from user input — cannot perform DDL on the database.
  const runtimeConnectionString = await provisionRuntimeRoleAndUrl(config.databaseUrl);
  db = createDb(runtimeConnectionString);
  logger.info(
    { runtimeRole: RUNTIME_DB_ROLE_NAME },
    "Using external PostgreSQL via DATABASE_URL/config (runtime queries scoped to restricted role)",
  );
  // Backups still use the migration role: pg_dump-style introspection needs
  // sequence reads and other catalogs the restricted runtime role does not
  // (and should not) have access to.
  backupDatabaseConnectionString = config.databaseUrl;
  startupDbInfo = { mode: "external-postgres", connectionString: runtimeConnectionString };
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

  const dataDir = resolve(config.embeddedPostgresDataDir);
  const configuredPort = config.embeddedPostgresPort;
  let port = configuredPort;
  const embeddedPostgresLogBuffer: string[] = [];
  const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
  const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
  const appendEmbeddedPostgresLog = (message: unknown) => {
    const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line) continue;
      embeddedPostgresLogBuffer.push(line);
      if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
        embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
      }
      if (verboseEmbeddedPostgresLogs) {
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    }
  };
  const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
    if (embeddedPostgresLogBuffer.length > 0) {
      logger.error(
        {
          phase,
          recentLogs: embeddedPostgresLogBuffer,
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
    const detectedPort = await detectPort(configuredPort);
    if (detectedPort !== configuredPort) {
      logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
    }
    port = detectedPort;
    logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      onLog: appendEmbeddedPostgresLog,
      onError: appendEmbeddedPostgresLog,
    });

    if (!clusterAlreadyInitialized) {
      try {
        await embeddedPostgres.initialise();
      } catch (err) {
        logEmbeddedPostgresFailure("initialise", err);
        throw err;
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
      throw err;
    }
    embeddedPostgresStartedByThisProcess = true;
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

  // Embedded PostgreSQL is local-only and is never bound to anything but
  // 127.0.0.1, so we deliberately skip the runtime-role split here and reuse
  // the migration credentials. Splitting them would force every dev-mode user
  // to also configure PAPERCLIP_RUNTIME_DB_PASSWORD, which is gratuitous when
  // the database is unreachable from outside the host. External Postgres
  // (DATABASE_URL set) always provisions the restricted runtime role above.
  db = createDb(embeddedConnectionString);
  logger.info(
    "Embedded PostgreSQL ready (runtime-role split skipped: embedded mode reuses migration credentials)",
  );
  backupDatabaseConnectionString = embeddedConnectionString;
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
if (config.deploymentMode === "authenticated") {
  const {
    createBetterAuthHandler,
    createBetterAuthInstance,
    deriveAuthTrustedOrigins,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  } = await import("./auth/better-auth.js");
  const betterAuthSecret =
    process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!betterAuthSecret) {
    throw new Error(
      "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) to be set",
    );
  }
  const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
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

const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
const storageService = createStorageServiceFromConfig(config);
const app = await createApp(db as any, {
  uiMode,
  storageService,
  deploymentMode: config.deploymentMode,
  deploymentExposure: config.deploymentExposure,
  allowedHostnames: config.allowedHostnames,
  bindHost: config.host,
  authReady,
  companyDeletionEnabled: config.companyDeletionEnabled,
  betterAuthHandler,
  resolveSession,
});
const server = createServer(app as unknown as Parameters<typeof createServer>[0]);
const listenPort = await detectPort(config.port);

if (listenPort !== config.port) {
  logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
}

const runtimeListenHost = config.host;
const runtimeApiHost =
  runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
    ? "localhost"
    : runtimeListenHost;
process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;

setupLiveEventsWebSocketServer(server, db as any, {
  deploymentMode: config.deploymentMode,
  resolveSessionFromHeaders,
});

if (config.heartbeatSchedulerEnabled) {
  const heartbeat = heartbeatService(db as any);

  // Reap orphaned runs at startup (no threshold -- runningProcesses is empty)
  void heartbeat.reapOrphanedRuns().catch((err) => {
    logger.error({ err }, "startup reap of orphaned heartbeat runs failed");
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

    // Periodically reap orphaned runs (5-min staleness threshold)
    void heartbeat
      .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
      .catch((err) => {
        logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
      });
  }, config.heartbeatSchedulerIntervalMs);
}

initTelegramNotifications(db);

// ---------------------------------------------------------------------------
// Schema integrity watchdog
// ---------------------------------------------------------------------------
// Catches the "we lost data overnight" failure mode where a critical table
// goes missing (botched migration, restored backup with the wrong schema,
// accidental DROP) and nobody notices until users hit broken pages.
//
// Runs every 60s, alerts via Telegram if a check fails, and dedupes alerts
// so a persistent failure pages on at most a 5-minute cadence rather than
// flooding the channel.
{
  const SCHEMA_CHECK_INTERVAL_MS = 60 * 1000;
  const SCHEMA_ALERT_DEDUP_MS = 5 * 60 * 1000;
  let lastAlertSentAt = 0;
  let lastAlertSignature: string | null = null;

  const runSchemaCheck = async () => {
    let result;
    try {
      result = await checkSchemaIntegrity(db as any);
    } catch (err) {
      logger.error({ err }, "Schema integrity check threw unexpectedly");
      return;
    }
    if (result.status !== "degraded") {
      // Recovery: clear dedup so the next failure alerts immediately.
      if (lastAlertSignature !== null) {
        logger.info({ checkedAt: result.checkedAt }, "Schema integrity recovered");
        lastAlertSignature = null;
        lastAlertSentAt = 0;
      }
      return;
    }

    const signature = result.missingTables.slice().sort().join(",");
    const now = Date.now();
    const sameFailure = signature === lastAlertSignature;
    const withinDedupWindow = now - lastAlertSentAt < SCHEMA_ALERT_DEDUP_MS;
    const shouldAlert = !sameFailure || !withinDedupWindow;

    logger.error(
      {
        missingTables: result.missingTables,
        errors: result.errors,
        checkedAt: result.checkedAt,
        willAlert: shouldAlert,
      },
      "SCHEMA INTEGRITY CHECK FAILED",
    );

    if (!shouldAlert) return;

    lastAlertSentAt = now;
    lastAlertSignature = signature;
    const summary = result.errors
      .map((e) => `${e.table}: ${e.message}`)
      .join("; ");
    void notifyOps(
      `Schema integrity check FAILED: missing/broken tables [${result.missingTables.join(", ")}] — ${summary}`,
      "error",
    ).catch((err) => {
      logger.warn({ err }, "Failed to send schema integrity Telegram alert");
    });
  };

  // Kick off once at startup so a broken deploy is caught immediately
  // instead of waiting a full interval.
  void runSchemaCheck();
  setInterval(() => {
    void runSchemaCheck();
  }, SCHEMA_CHECK_INTERVAL_MS);
}

if (config.databaseBackupEnabled) {
  const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
  let backupInFlight = false;

  const runScheduledBackup = async () => {
    if (backupInFlight) {
      logger.warn("Skipping scheduled database backup because a previous backup is still running");
      return;
    }

    backupInFlight = true;
    try {
      const result = await runDatabaseBackup({
        connectionString: backupDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retentionDays: config.databaseBackupRetentionDays,
        filenamePrefix: "paperclip",
      });
      // Refresh a stable `latest.sql` pointer next to the timestamped backup
      // so recovery tooling (and humans) can always grab the most recent
      // dump without having to sort by mtime. We use a file copy rather than
      // a symlink because the backup directory is typically a host
      // bind-mount that does not always tolerate symlinks cleanly.
      try {
        const latestPath = resolve(config.databaseBackupDir, "latest.sql");
        copyFileSync(result.backupFile, latestPath);
      } catch (latestErr) {
        logger.warn(
          { err: latestErr, backupDir: config.databaseBackupDir },
          "Failed to refresh latest.sql pointer",
        );
      }
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
        },
        `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
    } finally {
      backupInFlight = false;
    }
  };

  logger.info(
    {
      intervalMinutes: config.databaseBackupIntervalMinutes,
      retentionDays: config.databaseBackupRetentionDays,
      backupDir: config.databaseBackupDir,
    },
    "Automatic database backups enabled",
  );
  setInterval(() => {
    void runScheduledBackup();
  }, backupIntervalMs);
}

// Backfill: ensure all existing agents have their role-default permissions.
// Agents created before the auto-grant feature may be missing grants.
{
  const access = accessService(db);
  const agentSvc = agentService(db);
  const allCompanies = await db.select({ id: companies.id }).from(companies);
  let backfilled = 0;
  for (const company of allCompanies) {
    const agentList = await agentSvc.list(company.id);
    for (const agent of agentList) {
      const defaultPerms = AGENT_ROLE_DEFAULT_PERMISSIONS[agent.role] ?? [];
      if (defaultPerms.length === 0) continue;
      // Check if agent already has grants
      const membership = await access.getMembership(company.id, "agent", agent.id);
      if (!membership) {
        await access.ensureMembership(company.id, "agent", agent.id, "member", "active");
      }
      // Get existing grants and add missing ones
      const existing = await db
        .select()
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalType, "agent"),
            eq(principalPermissionGrants.principalId, agent.id),
          ),
        );
      const existingKeys = new Set(existing.map((g) => g.permissionKey));
      const missing = defaultPerms.filter((k) => !existingKeys.has(k));
      if (missing.length > 0) {
        const allKeys = [...existingKeys, ...missing];
        await access.setPrincipalGrants(
          company.id,
          "agent",
          agent.id,
          allKeys.map((key) => ({ permissionKey: key as any })),
          null,
        );
        backfilled++;
        logger.info({ agentId: agent.id, role: agent.role, added: missing }, "Backfilled agent permissions");
      }
    }
  }
  if (backfilled > 0) {
    logger.info({ count: backfilled }, "Agent permission backfill complete");
  }
}

server.listen(listenPort, config.host, () => {
  logger.info(`Server listening on ${config.host}:${listenPort}`);
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
    host: config.host,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authReady,
    requestedPort: config.port,
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
});

if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    logger.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await embeddedPostgres?.stop();
    } catch (err) {
      logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
