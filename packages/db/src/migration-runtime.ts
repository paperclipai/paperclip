import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { ensurePostgresDatabase, getPostgresDataDirectory } from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { resolveDatabaseTarget } from "./runtime-config.js";

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

export type MigrationConnection = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(error.code === "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close();
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  const maxLookahead = 20;
  let port = startPort;
  for (let i = 0; i < maxLookahead; i += 1, port += 1) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(
    `Embedded PostgreSQL could not find a free port from ${startPort} to ${startPort + maxLookahead - 1}`,
  );
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
}

/**
 * Normalizes locale values in postgresql.conf when an existing cluster was
 * created on a different platform (e.g. Linux Docker → macOS embedded-postgres).
 *
 * Linux uses the POSIX shorthand "*.utf8" for UTF-8 locales (e.g. "en_US.utf8"),
 * while macOS setlocale() only recognises the RFC-standard form "*.UTF-8"
 * (e.g. "en_US.UTF-8"). PostgreSQL stores the locale at initdb time and
 * validates it at every startup, so a cluster initialised on Linux will fail
 * to start on macOS with "invalid value for parameter lc_messages".
 *
 * This function rewrites all lc_* parameters in postgresql.conf from the
 * "*.utf8" form to "*.UTF-8" — silently, and only when a change is needed.
 * The replacement is locale-agnostic: it handles en_US, de_DE, fr_FR, ja_JP,
 * and any other locale that PostgreSQL may have stored with the ".utf8" suffix.
 */
function normalizePostgresConfigLocales(dataDir: string): void {
  const confPath = path.resolve(dataDir, "postgresql.conf");
  if (!existsSync(confPath)) return;

  const original = readFileSync(confPath, "utf8");

  // Convert any "*.utf8" locale value to the RFC-standard "*.UTF-8" form that
  // macOS setlocale() recognises, so a cluster created on Linux can start on macOS.
  const normalized = original.replace(
    /\b(lc_messages|lc_monetary|lc_numeric|lc_time)(\s*=\s*'[^']+?)\.utf8'/g,
    "$1$2.UTF-8'",
  );

  if (normalized !== original) {
    writeFileSync(confPath, normalized, "utf8");
  }
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();
  const selectedPort = await findAvailablePort(preferredPort);
  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const pgVersionFile = path.resolve(dataDir, "PG_VERSION");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  const runningPort = readPidFilePort(postmasterPidFile);
  const preferredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/postgres`;
  const logBuffer = createEmbeddedPostgresLogBuffer();

  if (!runningPid && existsSync(pgVersionFile)) {
    try {
      const actualDataDir = await getPostgresDataDirectory(preferredAdminConnectionString);
      const matchesDataDir =
        typeof actualDataDir === "string" &&
        path.resolve(actualDataDir) === path.resolve(dataDir);
      if (!matchesDataDir) {
        throw new Error("reachable postgres does not use the expected embedded data directory");
      }
      await ensurePostgresDatabase(preferredAdminConnectionString, "paperclip");
      process.emitWarning(
        `Adopting an existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} because postmaster.pid is missing.`,
      );
      return {
        connectionString: `postgres://paperclip:paperclip@127.0.0.1:${preferredPort}/paperclip`,
        source: `embedded-postgres@${preferredPort}`,
        stop: async () => {},
      };
    } catch {
      // Fall through and attempt to start the configured embedded cluster.
    }
  }

  if (runningPid) {
    const port = runningPort ?? preferredPort;
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    return {
      connectionString: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port: selectedPort,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage:
          `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${selectedPort}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  // Normalize locale settings in postgresql.conf so that a cluster created on
  // Linux (Docker) can be started on macOS (embedded-postgres) and vice-versa.
  normalizePostgresConfigLocales(dataDir);
  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "paperclip");

  return {
    connectionString: `postgres://paperclip:paperclip@127.0.0.1:${selectedPort}/paperclip`,
    source: `embedded-postgres@${selectedPort}`,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function resolveMigrationConnection(): Promise<MigrationConnection> {
  const target = resolveDatabaseTarget();
  if (target.mode === "postgres") {
    return {
      connectionString: target.connectionString,
      source: target.source,
      stop: async () => {},
    };
  }

  return ensureEmbeddedPostgresConnection(target.dataDir, target.port);
}
