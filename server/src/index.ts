/// <reference path="./types/express.d.ts" />
import fs from "node:fs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { resolve } from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
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
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  backfillPrincipalAccessCompatibility,
  bootstrapExecutionPolicyFromEnv,
  heartbeatService,
  instanceSettingsService,
  reconcileCloudUpstreamRunsOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import {
  parseAdapterRegistryEnv,
  reconcileAdapterAvailability,
} from "./services/adapter-registry-bootstrap.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createApiTierPluginWorkerManagerStub } from "./services/plugin-worker-manager-stub.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { logShutdownSignal, writeShutdownBreadcrumb } from "./shutdown-log.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { plugins } from "@paperclipai/db";
import {
  autoConfigureAlertmanagerFromEnv,
  autoConfigureLinearFromEnv,
  installKkrooLocalPlugins,
} from "./bootstrap/kkroo-bundled-plugins.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";

/**
 * Bundled plugins that should be auto-installed on startup.
 * These are npm packages that get installed if not already present.
 *
 * Note: `@lucitra/paperclip-plugin-linear` was previously listed here but is
 * now vendored as a workspace package at `packages/plugins/paperclip-plugin-linear`
 * and installed from that local path further below. Listing it here would
 * race the npm install ahead of the local install, ending up with whatever
 * version is on npm rather than the in-image version with kkroo fixes.
 */
const BUNDLED_PLUGINS = [
  "@lucitra/paperclip-plugin-chat",
  "@lucitra/paperclip-plugin-updater",
  "@lucitra/paperclip-plugin-secrets",
];

async function autoInstallBundledPlugins(
  _db: import("@paperclipai/db").Db,
  internalBootstrapToken: string,
) {
  // Wait for the server to be fully up before calling the install API
  const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
  const baseUrl = `http://127.0.0.1:${port}`;
  // The /api/plugins/install route requires assertInstanceAdmin. Loopback
  // requests carrying this token are accepted as instance admin (see
  // actorMiddleware -> internalBootstrapToken). Without it we'd 403 here.
  const internalHeaders = {
    "x-paperclip-internal-bootstrap": internalBootstrapToken,
  } as const;
  // Wrap fetch to auto-attach the bootstrap header for every loopback call
  // we make in this function. External calls (npm registry) should still use
  // plain fetch so we don't leak the token.
  const fetchInternal = (input: string | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...internalHeaders },
    });

  // Install npm-based bundled plugins
  for (const pkg of BUNDLED_PLUGINS) {
    try {
      const listRes = await fetchInternal(`${baseUrl}/api/plugins`);
      if (listRes.ok) {
        const plugins = (await listRes.json()) as Array<{ packageName: string; pluginKey: string; status: string }>;
        const existing = plugins.find((p) => p.packageName === pkg || p.pluginKey === pkg);
        // Treat disabled / pending-approval bundled plugins as already
        // installed. Re-posting them on every startup only produces a 400
        // "already installed" response and hides real bootstrap failures.
        if (existing && existing.status !== "error") continue;
      }

      logger.info({ package: pkg }, "auto-installing bundled plugin via API");
      const installRes = await fetchInternal(`${baseUrl}/api/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageName: pkg }),
      });

      if (installRes.ok) {
        const result = (await installRes.json()) as { pluginKey?: string; status?: string };
        logger.info({ pluginKey: result.pluginKey, status: result.status }, "bundled plugin installed and loaded");
      } else {
        const err = (await installRes.json()) as { error?: string };
        if (!err.error?.includes("already installed")) {
          logger.warn({ package: pkg, error: err.error }, "bundled plugin install failed");
        }
      }
    } catch (err) {
      logger.warn({ package: pkg, err }, "failed to auto-install bundled plugin");
    }
  }

  // Auto-upgrade bundled plugins if a newer version is available on npm
  // Set PAPERCLIP_AUTO_UPGRADE_PLUGINS=false to disable
  if (process.env.PAPERCLIP_AUTO_UPGRADE_PLUGINS === "false") {
    logger.info("auto-upgrade disabled via PAPERCLIP_AUTO_UPGRADE_PLUGINS=false");
  } else try {
    const listRes3 = await fetchInternal(`${baseUrl}/api/plugins`);
    if (listRes3.ok) {
      const allPlugins = (await listRes3.json()) as Array<{
        id: string; packageName: string; version: string; status: string;
      }>;
      for (const pkg of BUNDLED_PLUGINS) {
        const installed = allPlugins.find((p) => p.packageName === pkg && p.status === "ready");
        if (!installed) continue;

        try {
          // Check npm for latest version (abbreviated metadata for speed)
          const npmRes = await fetch(
            `https://registry.npmjs.org/${encodeURIComponent(pkg)}`,
            { headers: { Accept: "application/vnd.npm.install-v1+json" } },
          );
          if (!npmRes.ok) continue;
          const npmData = (await npmRes.json()) as { "dist-tags"?: { latest?: string } };
          const latest = npmData["dist-tags"]?.latest;
          if (!latest || latest === installed.version) continue;

          // Simple semver comparison: split and compare numerically
          const parse = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map(Number);
          const cur = parse(installed.version);
          const lat = parse(latest);
          let isNewer = false;
          for (let i = 0; i < 3; i++) {
            if ((lat[i] ?? 0) > (cur[i] ?? 0)) { isNewer = true; break; }
            if ((lat[i] ?? 0) < (cur[i] ?? 0)) break;
          }
          if (!isNewer) continue;

          logger.info(
            { package: pkg, current: installed.version, latest },
            "auto-upgrading bundled plugin",
          );
          const upgradeRes = await fetchInternal(`${baseUrl}/api/plugins/${installed.id}/upgrade`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: latest }),
          });
          if (upgradeRes.ok) {
            logger.info({ package: pkg, latest }, "bundled plugin auto-upgraded");
          } else {
            const err = (await upgradeRes.json()) as { error?: string };
            // Capability escalation is expected — log but don't fail
            if (err.error?.includes("capability")) {
              logger.info({ package: pkg, latest }, "auto-upgrade pending capability approval");
            } else {
              logger.warn({ package: pkg, error: err.error }, "auto-upgrade failed");
            }
          }
        } catch (err) {
          logger.warn({ package: pkg, err }, "failed to check/upgrade bundled plugin");
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "auto-upgrade check failed (non-fatal)");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Kkroo-specific bundled-plugin bootstrap. Lives in a separate file so
  // future merges of paperclipai/master don't conflict on this function.
  // See server/src/bootstrap/kkroo-bundled-plugins.ts.
  // ──────────────────────────────────────────────────────────────────────────
  await installKkrooLocalPlugins({ baseUrl, fetchInternal });
  await autoConfigureLinearFromEnv({ baseUrl, fetchInternal });
  await autoConfigureAlertmanagerFromEnv({ baseUrl, fetchInternal });
}

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
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
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
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
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
  const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
  if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
    logger.info(accessBackfill, "Backfilled principal access compatibility records");
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
  // Overwrite only the SDK JS files that contain our fork extensions.
  // We must NOT delete the whole SDK dir or its package.json — the npm-installed
  // SDK has proper dependency resolution for @paperclipai/shared that we need.
  function copyWorkspaceSdkFiles() {
    try {
      const pluginsSdkDist = path.join(os.homedir(), ".paperclip", "plugins", "node_modules", "@paperclipai", "plugin-sdk", "dist");
      const thisDir = path.dirname(new URL(import.meta.url).pathname);
      const workspaceSdkDist = path.resolve(thisDir, "../../packages/plugins/sdk/dist");
      if (!fs.existsSync(workspaceSdkDist) || !fs.existsSync(pluginsSdkDist)) return;

      // Only overwrite the specific files we changed (fork extensions)
      const filesToCopy = [
        "worker-rpc-host.js",
        "worker-rpc-host.js.map",
        "worker-rpc-host.d.ts",
        "worker-rpc-host.d.ts.map",
        "host-client-factory.js",
        "host-client-factory.js.map",
        "host-client-factory.d.ts",
        "host-client-factory.d.ts.map",
        "protocol.js",
        "protocol.js.map",
        "protocol.d.ts",
        "protocol.d.ts.map",
        "types.js",
        "types.js.map",
        "types.d.ts",
        "types.d.ts.map",
        "testing.js",
        "testing.js.map",
        "testing.d.ts",
        "testing.d.ts.map",
      ];
      let copied = 0;
      for (const file of filesToCopy) {
        const src = path.join(workspaceSdkDist, file);
        const dest = path.join(pluginsSdkDist, file);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, { force: true });
          copied++;
        }
      }
      if (copied > 0) {
        logger.info(`Patched ${copied} workspace SDK files into local plugins directory`);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to patch workspace SDK files (non-fatal)");
    }
  }
  copyWorkspaceSdkFiles();

  // The npm-installed @paperclipai/shared on the plugins side can lag the
  // workspace fork (its registry publish is date-versioned and is not
  // refreshed on every deploy). When it does, the fork plugin-SDK we vendor
  // above re-exports symbols (e.g. PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS)
  // that the stale registry shared does not provide, and plugin workers crash
  // with "does not provide an export named ...". Vendor the workspace shared
  // *dist* over the stale one so the SDK and shared are a matched fork pair.
  //
  // dist ONLY — do NOT copy the workspace shared package.json: its top-level
  // `exports` map points at ./src/*.ts (raw TS), whereas the registry copy's
  // `exports` already points at ./dist/*.js. Overwriting it would swap the
  // missing-export crash for ERR_MODULE_NOT_FOUND on the same plugins.
  function copyWorkspaceSharedDist() {
    try {
      const pluginsSharedDir = path.join(os.homedir(), ".paperclip", "plugins", "node_modules", "@paperclipai", "shared");
      const thisDir = path.dirname(new URL(import.meta.url).pathname);
      const workspaceSharedDist = path.resolve(thisDir, "../../packages/shared/dist");
      // Only act when both the workspace source and the installed target exist;
      // never create the package from nothing (mirrors the SDK copy guard).
      if (!fs.existsSync(workspaceSharedDist) || !fs.existsSync(pluginsSharedDir)) return;
      if (fs.lstatSync(pluginsSharedDir).isSymbolicLink()) {
        fs.unlinkSync(pluginsSharedDir);
        fs.mkdirSync(pluginsSharedDir, { recursive: true });
      }
      fs.cpSync(workspaceSharedDist, path.join(pluginsSharedDir, "dist"), { recursive: true });
      logger.info("Copied workspace @paperclipai/shared dist to local plugins directory");
    } catch (err) {
      logger.warn({ err }, "Failed to copy workspace shared dist (non-fatal)");
    }
  }

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
  // PAPERCLIP_NODE_ROLE=api uses a stub manager that throws on operations and
  // returns safe-empty for read queries. All other roles ("worker", "all")
  // get the real subprocess-spawning manager.
  const pluginWorkerManager =
    config.paperclipNodeRole === "api"
      ? createApiTierPluginWorkerManagerStub()
      : createPluginWorkerManager();
  // One-shot token used by autoInstallBundledPlugins to authenticate its
  // loopback HTTP calls to /api/plugins/install (which require instance admin).
  // Lives only in this Node process — never written to disk or logged.
  const internalBootstrapToken = randomBytes(32).toString("hex");
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    internalBootstrapToken,
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
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
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

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any, {
      pluginWorkerManager,
      // Failure-B fence (BLO-9089): only the workers/all tier claims+executes
      // runs. The api tier skips bundled-adapter load, so dispatching there
      // mis-resolves to the process adapter and fails with "Process adapter
      // missing command". Mirrors the !== "api" gating used for the other
      // singletons (plugins, reconciler, Linear tunnel) below.
      paperclipNodeRole: config.paperclipNodeRole,
    });
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
        const swept = await heartbeat.sweepStaleIssueLocks();
        if (swept.cleared > 0) {
          logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
        }
      })
      .then(async () => {
        const reviewed = await heartbeat.reconcileProductivityReviews();
        if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
          logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
        }
      })
      .then(async () => {
        const swept = await heartbeat.reconcileResolvedBlockerDependents();
        if (swept.woken > 0 || swept.failed > 0) {
          logger.warn({ ...swept }, "startup resolved-blocker-dependents sweep enqueued wakes");
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
        .then(async () => {
          const swept = await heartbeat.reconcileResolvedBlockerDependents();
          if (swept.woken > 0 || swept.failed > 0) {
            logger.warn({ ...swept }, "periodic resolved-blocker-dependents sweep enqueued wakes");
          }
        })
        .catch((err) => {
          logger.error({ err }, "periodic heartbeat recovery failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
  }
  
  // Database backup is a singleton scheduled task (writes one file per
  // interval; multiple replicas racing would clobber the same target).
  // Worker tier owns this; API tier skips it entirely.
  if (config.databaseBackupEnabled && config.paperclipNodeRole !== "api") {
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

  // Merged-PR reconciler (BLO-9150). Worker-tier singleton (API tier skips it):
  // enumerates each discovered repo's merged PRs over a trailing window and
  // stores the no-ref tail, which is what flips the efficiency coverage % from a
  // vacuous forward-only 100% to a measured number. Kicks off once on startup
  // (so coverage is honest without waiting a full interval) then runs on interval.
  if (config.prReconcilerEnabled && config.paperclipNodeRole !== "api") {
    const reconcilerToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
    if (!reconcilerToken) {
      logger.warn(
        "Merged-PR reconciler enabled but no GITHUB_TOKEN/GH_TOKEN set; private repos would 404. Skipping reconciler.",
      );
    } else {
      const reconcilerIntervalMs = config.prReconcilerIntervalMinutes * 60 * 1000;
      logger.info(
        {
          intervalMinutes: config.prReconcilerIntervalMinutes,
          windowDays: config.prReconcilerWindowDays,
          enrichLoc: config.prReconcilerEnrichLoc,
        },
        "Merged-PR reconciler enabled",
      );
      const { reconcilerSweepTick } = await import("./services/pr-reconciler-sweep.js");
      const runReconcilerSweepTick = () =>
        void reconcilerSweepTick(db, {
          windowDays: config.prReconcilerWindowDays,
          token: reconcilerToken,
          enrichLoc: config.prReconcilerEnrichLoc,
        }).catch((err) => {
          logger.error({ err }, "Merged-PR reconciler sweep failed");
        });
      runReconcilerSweepTick();
      setInterval(runReconcilerSweepTick, reconcilerIntervalMs);
    }
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

  // Ensure plugins directory uses the workspace SDK (with fork extensions).
  // Copy the built dist + package.json from the workspace SDK into the plugins
  // node_modules so workers use our fork's SDK (with labels/projects extensions).
  try {
    const pluginsSdkDir = path.join(os.homedir(), ".paperclip", "plugins", "node_modules", "@paperclipai", "plugin-sdk");
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const workspaceSdkDist = path.resolve(thisDir, "../../packages/plugins/sdk/dist");
    const workspaceSdkPkg = path.resolve(thisDir, "../../packages/plugins/sdk/package.json");
    if (fs.existsSync(workspaceSdkDist) && fs.existsSync(pluginsSdkDir)) {
      // Remove symlink if left over from a previous approach
      if (fs.lstatSync(pluginsSdkDir).isSymbolicLink()) {
        fs.unlinkSync(pluginsSdkDir);
        fs.mkdirSync(pluginsSdkDir, { recursive: true });
      }
      fs.cpSync(workspaceSdkDist, path.join(pluginsSdkDir, "dist"), { recursive: true });
      if (fs.existsSync(workspaceSdkPkg)) {
        fs.cpSync(workspaceSdkPkg, path.join(pluginsSdkDir, "package.json"));
      }
      logger.info("Copied workspace plugin SDK dist to local plugins directory");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to copy workspace SDK (non-fatal)");
  }
  // Keep shared in lockstep with the vendored fork SDK (see note above).
  copyWorkspaceSharedDist();

  // Auto-install bundled plugins (idempotent — skips if already installed).
  // Skipped on the API tier: /api/plugins/install hits pluginWorkerManager
  // which is stubbed; the workers tier owns plugin installs.
  if (config.paperclipNodeRole !== "api") {
    void autoInstallBundledPlugins(db as any, internalBootstrapToken).then(() => {
      // Re-patch workspace SDK after plugin installs — npm install pulls the upstream SDK.
      copyWorkspaceSdkFiles();
      // …and the upstream shared it dragged in, so the matched fork pair survives.
      copyWorkspaceSharedDist();
    }).catch((err) => {
      logger.warn({ err }, "auto-install of bundled plugins failed (non-fatal)");
    });
  } else {
    logger.info(
      { role: config.paperclipNodeRole },
      "skipping auto-install of bundled plugins (API tier — workers tier owns plugin lifecycle)",
    );
  }

  // BLO-6295 piece D — daily Microsoft Entra group reconciler. Gated on
  // MICROSOFT_GROUP_RECONCILE_ENABLED=true; only the worker / all tier
  // runs it so HA API replicas don't spin up parallel reconcilers.
  if (
    process.env.MICROSOFT_GROUP_RECONCILE_ENABLED === "true" &&
    config.paperclipNodeRole !== "api"
  ) {
    void (async () => {
      try {
        const { startMicrosoftGroupReconciler } = await import(
          "./services/microsoft-group-reconciler.js"
        );
        startMicrosoftGroupReconciler({ db: db as any });
        logger.info(
          { role: config.paperclipNodeRole },
          "microsoft-group-reconciler started",
        );
      } catch (err) {
        logger.warn({ err }, "microsoft-group-reconciler failed to start (non-fatal)");
      }
    })();
  }

  // Start Linear tunnel if Linear is connected and cloudflared is available.
  // The tunnel is a singleton outbound cloudflared process; running multiple
  // copies (one per API replica) would point Linear's webhooks at whichever
  // tunnel won the race. Worker tier owns this.
  if (config.linearOAuthClientId && config.paperclipNodeRole !== "api") {
    void (async () => {
      try {
        const { secretService } = await import("./services/index.js");
        const svc = secretService(db as any);
        // Find any company with a Linear token
        const allCompanies = await (db as any).select().from(companies);
        for (const company of allCompanies) {
          const linearSecret = await svc.getByName(company.id, "linear-oauth-token");
          if (linearSecret) {
            const token = await svc.resolveSecretValue(company.id, linearSecret.id, "latest");
            // Get teamId from plugin config
            const [plugin] = await (db as any).select().from(plugins).where(eq(plugins.pluginKey, "paperclip-plugin-linear")).limit(1);
            let teamId = "";
            if (plugin) {
              const { pluginConfig: pluginConfigTable } = await import("@paperclipai/db");
              const [cfg] = await (db as any).select().from(pluginConfigTable).where(eq(pluginConfigTable.pluginId, plugin.id));
              teamId = (cfg?.configJson as Record<string, unknown>)?.teamId as string ?? "";
            }
            if (token && teamId) {
              const { startLinearTunnel } = await import("./linear-tunnel.js");
              await startLinearTunnel({ port: listenPort, linearToken: token, teamId });
            }
            break; // Only need one company's token
          }
        }
      } catch (err) {
        logger.info("[linear-tunnel] skipped (not connected or cloudflared unavailable)");
      }
    })();
  }

  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      // Synchronous stderr breadcrumb FIRST — survives pino's async transport
      // dropping logs across process.exit. See BLO-4137 post-merge gap.
      logShutdownSignal(signal);
      logger.info({ signal }, "Shutdown signal received — beginning graceful drain");

      // 1. Drain SSE bridge streams FIRST — emit `event: shutdown` on each,
      //    end() the socket, and await each response's 'finish' event so the
      //    shutdown frame actually hits the wire before we proceed. Order
      //    matters: server.close() below blocks on existing connections, so
      //    if we awaited it before draining we'd deadlock on the SSE sockets.
      //    Bounded by timeoutMs so a wedged stream can't hold the whole
      //    process past terminationGracePeriod.
      try {
        const { sseRegistry } = await import("./services/sse-registry.js");
        await sseRegistry.drain({ timeoutMs: 25_000, reason: `shutdown:${signal}` });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Mirror to stderr — see writeShutdownBreadcrumb for why pino alone
        // can lose late-shutdown lines on process.exit.
        writeShutdownBreadcrumb(`sseRegistry.drain failed: ${errMsg}`);
        logger.warn({ err }, "sseRegistry.drain failed");
      }

      // 2. Now stop accepting new connections. With SSEs drained, server.close
      //    has no long-lived connections to wait on and resolves quickly. The
      //    closeIdleConnections call sweeps up any remaining keep-alive
      //    sockets that might otherwise keep the callback pending.
      await new Promise<void>((resolve) => {
        server.close((err) => {
          if (err) logger.warn({ err }, "server.close error");
          resolve();
        });
        server.closeIdleConnections?.();
      });

      // Flush telemetry
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      // Stop Linear tunnel and delete webhook
      try {
        const { stopLinearTunnel } = await import("./linear-tunnel.js");
        let cleanupToken: string | undefined;
        try {
          const { secretService } = await import("./services/index.js");
          const svc = secretService(db as any);
          const allCompanies = await (db as any).select().from(companies);
          for (const c of allCompanies) {
            const s = await svc.getByName(c.id, "linear-oauth-token");
            if (s) { cleanupToken = await svc.resolveSecretValue(c.id, s.id, "latest"); break; }
          }
        } catch { /* best effort */ }
        await stopLinearTunnel(cleanupToken);
      } catch { /* best effort */ }

      const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } }).locals?.paperclipShutdown;
      appShutdown?.();

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        writeShutdownBreadcrumb(`stopping embedded PostgreSQL (signal=${signal})`);
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          writeShutdownBreadcrumb(`embedded PostgreSQL stop failed: ${errMsg}`);
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      writeShutdownBreadcrumb(`handler complete; exiting (signal=${signal})`);
      logger.info({ signal }, "Shutdown handler complete; exiting");

      // Flush pino's async buffer before process.exit. Otherwise the trailing
      // log lines (and any straggler writes from the drain/close steps) are
      // dropped when libuv stops, making post-mortem debugging blind.
      try {
        (logger as unknown as { flush?: (cb?: () => void) => void }).flush?.();
      } catch { /* best effort */ }

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
}
