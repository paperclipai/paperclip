/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
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
  heartbeatService,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { plugins } from "@paperclipai/db";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "./services/plugin-loader.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";

/**
 * Bundled plugins that should be auto-installed on startup.
 *
 * String entries are npm package names. Object entries with `isLocalPath: true`
 * point at a directory on disk (used for plugins that live as sibling
 * submodules in the lucitra-dev monorepo and aren't published to npm).
 */
type BundledPlugin =
  | string
  | { packageName: string; isLocalPath: true; pluginKey: string };

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

const BUNDLED_PLUGINS: BundledPlugin[] = [
  "@lucitra/paperclip-plugin-secrets",
  "@lucitra/paperclip-plugin-updater",
  "paperclip-plugin-slack",
  // Linear plugin: lives as a sibling submodule. Loaded from source so local
  // bugfixes (e.g. the totalCount GraphQL schema drift) take effect without
  // an npm publish round-trip.
  {
    packageName: resolve(SERVER_DIR, "../../../paperclip-plugin-linear"),
    isLocalPath: true,
    pluginKey: "paperclip-plugin-linear",
  },
  // Chat plugin: lives as a sibling submodule in lucitra-dev.
  // Loaded from source so the Agent SDK rewrite + @lucitra/mcp-paperclip
  // file: dep resolve without an npm publish round-trip.
  {
    packageName: resolve(SERVER_DIR, "../../../paperclip-plugin-chat"),
    isLocalPath: true,
    pluginKey: "paperclip-chat",
  },
  // Lucitra Capital — Kalshi event-market broker. Lives as a sibling
  // submodule in lucitra-dev; private repo, not published to npm.
  {
    packageName: resolve(SERVER_DIR, "../../../paperclip-plugin-kalshi"),
    isLocalPath: true,
    pluginKey: "paperclip-plugin-kalshi",
  },
  // Lucitra Capital — cross-asset research (FRED, SEC EDGAR, Tavily).
  // Layer 1 read-only. Sibling submodule in lucitra-dev.
  {
    packageName: resolve(SERVER_DIR, "../../../paperclip-plugin-research"),
    isLocalPath: true,
    pluginKey: "paperclip-plugin-research",
  },
  // Lucitra Capital — equity market data (Tiingo IEX quotes + daily OHLCV).
  // Owned data infrastructure, not a SaaS wrapper. Sibling in lucitra-dev.
  {
    packageName: resolve(SERVER_DIR, "../../../paperclip-plugin-market-data"),
    isLocalPath: true,
    pluginKey: "paperclip-plugin-market-data",
  },
];

async function autoInstallBundledPlugins(_db: import("@paperclipai/db").Db) {
  // Wait for the server to be fully up before calling the install API
  const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
  const baseUrl = `http://127.0.0.1:${port}`;

  // Install bundled plugins
  for (const entry of BUNDLED_PLUGINS) {
    const isLocalPath = typeof entry !== "string" && entry.isLocalPath === true;
    const pkg = typeof entry === "string" ? entry : entry.packageName;
    const lookupKey = typeof entry === "string" ? entry : entry.pluginKey;
    try {
      const listRes = await fetch(`${baseUrl}/api/plugins`);
      if (listRes.ok) {
        const plugins = (await listRes.json()) as Array<{ packageName: string; pluginKey: string; status: string }>;
        const existing = plugins.find(
          (p) => p.packageName === pkg || p.pluginKey === lookupKey,
        );
        if (existing && existing.status === "ready") continue;
      }

      logger.info({ package: pkg, isLocalPath }, "auto-installing bundled plugin via API");
      const installRes = await fetch(`${baseUrl}/api/plugins/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isLocalPath ? { packageName: pkg, isLocalPath: true } : { packageName: pkg },
        ),
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

}

/**
 * Auto-seed research plugin secrets from environment variables.
 *
 * Reads FRED_API_KEY, TAVILY_API_KEY, and SEC_EDGAR_USER_AGENT from
 * process.env. If present, creates corresponding Paperclip secrets
 * (idempotent — skips if they already exist) and saves the research
 * plugin instance config with the secret refs.
 */
async function autoSeedResearchSecrets() {
  const fredKey = process.env.FRED_API_KEY?.trim();
  const secEdgarAgent = process.env.SEC_EDGAR_USER_AGENT?.trim();
  const tiingoEnv = process.env.TIINGO_API_KEY?.trim();
  const finnhubEnv = process.env.FINNHUB_API_KEY?.trim();

  // Only proceed if at least one key is set
  if (!fredKey && !secEdgarAgent && !tiingoEnv && !finnhubEnv) return;

  const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
    });
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    return body;
  };

  // Find the research + secrets plugins and a company
  const plugins = await api("/api/plugins") as Array<{ id: string; pluginKey: string; status: string }>;
  const research = plugins.find((p) => p.pluginKey === "paperclip-plugin-research");
  const secrets = plugins.find((p) => p.pluginKey === "lucitra.plugin-secrets");
  if (!research || !secrets) {
    logger.debug("auto-seed research: research or secrets plugin not ready yet");
    return;
  }

  const companies = await api("/api/companies") as Array<{ id: string; name?: string }>;
  if (!companies.length) return;

  // Seed secrets into ALL companies so the UI sees them regardless of
  // which company is active.  Returns the first company's secret IDs
  // for use in plugin config (config is per-plugin, not per-company).
  const secretIdsByName: Record<string, string> = {};

  for (const company of companies) {
    const listResp = await api(`/api/plugins/${secrets.id}/data/list-secrets`, {
      method: "POST",
      body: JSON.stringify({ companyId: company.id, params: { companyId: company.id } }),
    });
    const existingArr = (() => {
      const data = listResp?.data ?? listResp ?? [];
      return Array.isArray(data) ? data : (data.secrets ?? []);
    })() as Array<{ id: string; name: string }>;
    const findExisting = (name: string) => existingArr.find((s) => s?.name === name);

    const createSecret = async (name: string, value: string): Promise<string> => {
      const existing = findExisting(name);
      if (existing) {
        if (!secretIdsByName[name]) secretIdsByName[name] = existing.id;
        return existing.id;
      }
      const resp = await api(`/api/plugins/${secrets.id}/actions/create-secret`, {
        method: "POST",
        body: JSON.stringify({
          companyId: company.id,
          params: { companyId: company.id, name, value, provider: "local_encrypted" },
        }),
      });
      const created = resp?.data ?? resp;
      const id = created?.id ?? created?.secret?.id;
      if (id && !secretIdsByName[name]) secretIdsByName[name] = id;
      return id;
    };

    // Create secrets for this company
    const tiingoKey = process.env.TIINGO_API_KEY?.trim();
    const finnhubKey = process.env.FINNHUB_API_KEY?.trim();
    if (finnhubKey) await createSecret("market-data-finnhub-api-key", finnhubKey);
    if (tiingoKey) await createSecret("market-data-tiingo-api-key", tiingoKey);
    if (fredKey) await createSecret("research-fred-api-key", fredKey);

    logger.info({ companyId: company.id }, "auto-seed: secrets seeded for company");
  } // end for-each company

  // Build research plugin config using the first company's secret IDs
  const configJson: Record<string, unknown> = {};
  if (secretIdsByName["market-data-tiingo-api-key"]) {
    configJson.tiingoApiKeyRef = secretIdsByName["market-data-tiingo-api-key"];
  }
  if (secretIdsByName["research-fred-api-key"]) {
    configJson.fredApiKeyRef = secretIdsByName["research-fred-api-key"];
  }
  if (secEdgarAgent) {
    configJson.secEdgarUserAgent = secEdgarAgent;
  }

  // Save research plugin config
  if (Object.keys(configJson).length > 0) {
    await api(`/api/plugins/${research.id}/config`, {
      method: "POST",
      body: JSON.stringify({ configJson }),
    });
    logger.info({ keys: Object.keys(configJson) }, "auto-seed research: config saved");
  }

  // Save market-data plugin config (Finnhub primary + Tiingo for FX/history)
  const marketDataConfig: Record<string, unknown> = {};
  if (secretIdsByName["market-data-finnhub-api-key"]) {
    marketDataConfig.finnhubApiKeyRef = secretIdsByName["market-data-finnhub-api-key"];
  }
  if (secretIdsByName["market-data-tiingo-api-key"]) {
    marketDataConfig.tiingoApiKeyRef = secretIdsByName["market-data-tiingo-api-key"];
  }
  if (Object.keys(marketDataConfig).length > 0) {
    const marketData = plugins.find((p) => p.pluginKey === "paperclip-plugin-market-data");
    if (marketData) {
      await api(`/api/plugins/${marketData.id}/config`, {
        method: "POST",
        body: JSON.stringify({ configJson: marketDataConfig }),
      });
      logger.info({ keys: Object.keys(marketDataConfig) }, "auto-seed market-data: config saved");
    }
  }
}

/**
 * Bootstrap the Lucitra Capital trading desk agent company from the
 * markdown source files in `lucitra-capital-company/`.
 *
 * This runs after `autoSeedResearchSecrets` so secrets are already seeded.
 * The bootstrap script is idempotent — on a fresh Paperclip install it
 * creates all agents + routines, on an existing install it updates them
 * in place without duplicating. Safe to run on every server startup.
 *
 * Source of truth for the company lives in git at
 * `lucitra-capital-company/`. Running this at startup guarantees that
 * the running Paperclip state matches the committed spec, even after a
 * `rm -rf ~/.paperclip`.
 */
async function autoBootstrapLucitraCapital() {
  // Path resolves relative to compiled dist location: dist/index.js
  // Walk up: dist → server → paperclip (submodule) → lucitra-dev
  const bootstrapPath = resolve(
    SERVER_DIR,
    "../../../lucitra-capital-company/scripts/bootstrap.ts",
  );
  const fs = await import("node:fs");
  if (!fs.existsSync(bootstrapPath)) {
    logger.debug({ bootstrapPath }, "lucitra-capital bootstrap script not found — skipping");
    return;
  }

  try {
    // Dynamic ESM import — runs the bootstrap as a side effect (its main()
    // is called at module load). The script is self-contained.
    const bootstrapUrl = pathToFileURL(bootstrapPath).href;
    await import(bootstrapUrl);
    logger.info("lucitra-capital bootstrap completed");
  } catch (err) {
    logger.warn({ err }, "lucitra-capital bootstrap failed (non-fatal)");
  }
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

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) return rawUrl;
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
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
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
  
  const listenPort = await detectPort(config.port);
  if (listenPort !== config.port) {
    config.port = listenPort;
  }
  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
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
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
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

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
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
  
  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const routines = routineService(db as any);
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
      .then(() => heartbeat.resumeQueuedRuns())
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
        .then(() => heartbeat.resumeQueuedRuns())
        .catch((err) => {
          logger.error({ err }, "periodic heartbeat recovery failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
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
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "paperclip",
        });
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
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

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

      resolveListen();
    });
  });

  // Auto-install bundled plugins (idempotent — skips if already installed),
  // then auto-seed research secrets from env vars, then bootstrap the
  // Lucitra Capital trading desk company from the markdown source files.
  void autoInstallBundledPlugins(db as any)
    .then(() => autoSeedResearchSecrets())
    .then(() => autoBootstrapLucitraCapital())
    .catch((err) => {
      logger.warn({ err }, "auto-install/seed/bootstrap failed (non-fatal)");
    });

  // Start Linear tunnel if Linear is connected and cloudflared is available
  if (config.linearOAuthClientId) {
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

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
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
