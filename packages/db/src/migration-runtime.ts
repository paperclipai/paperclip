import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  ensurePostgresDatabase,
  getPostgresDataDirectory,
  waitForPostgresReady,
} from "./client.js";
import { createEmbeddedPostgresLogBuffer, formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import {
  POSTMASTER_LOCK_FILE_NAME,
  inspectPostmasterLock,
  removeStalePostmasterLock,
} from "./embedded-postgres-lock.js";
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

function adminConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
}

function databaseConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
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

/** Whether the server answering on `port` is serving exactly `dataDir`. */
async function isServingDataDirectory(port: number, dataDir: string): Promise<boolean> {
  const actualDataDir = await getPostgresDataDirectory(adminConnectionString(port));
  return typeof actualDataDir === "string" && path.resolve(actualDataDir) === path.resolve(dataDir);
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
 * Attach to a cluster that is already serving `dataDir`, waiting out WAL
 * recovery first, and hand back a connection whose `stop` is a no-op — we did
 * not start this postmaster, so we must not stop it.
 */
async function adoptCluster(port: number): Promise<MigrationConnection> {
  await waitForPostgresReady(adminConnectionString(port));
  await ensurePostgresDatabase(adminConnectionString(port), "paperclip");
  return {
    connectionString: databaseConnectionString(port),
    source: `embedded-postgres@${port}`,
    stop: async () => {},
  };
}

/**
 * Resolve an already-running cluster for `dataDir`, or `null` when the
 * directory is free to start over.
 *
 * Two postmasters must never share a data directory: PostgreSQL fatals with
 * either a duplicate postmaster.pid or a pre-existing shared memory block. The
 * port fallback in the caller is therefore reachable only once this has
 * established that nothing owns the directory.
 */
async function resolveRunningCluster(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection | null> {
  const inspected = inspectPostmasterLock(dataDir);

  if (inspected.status === "running") {
    const port = inspected.lock.port ?? preferredPort;
    process.emitWarning(
      `Embedded PostgreSQL is already running for ${dataDir} (pid=${inspected.lock.pid}, port=${port}); reusing it.`,
    );
    return await adoptCluster(port);
  }

  if (inspected.status === "indeterminate") {
    const port = inspected.lock.port ?? preferredPort;
    try {
      const connection = await adoptCluster(port);
      process.emitWarning(
        `Adopted the PostgreSQL server on port ${port} for ${dataDir} after an inconclusive lock-file check.`,
      );
      return connection;
    } catch (error) {
      throw new Error(
        `Embedded PostgreSQL data directory ${dataDir} holds a ${POSTMASTER_LOCK_FILE_NAME} that cannot be ` +
          `adjudicated (${inspected.reason}), and no server answered on port ${port}. Refusing to start a ` +
          `second postmaster over live data. Stop any PostgreSQL still using this directory, then retry.`,
        { cause: error },
      );
    }
  }

  if (inspected.status === "stale") {
    const removal = removeStalePostmasterLock(dataDir);
    if (removal.removed) {
      process.emitWarning(
        `Removed ${POSTMASTER_LOCK_FILE_NAME} for ${dataDir} left behind by dead pid ${removal.lock.pid}.`,
      );
    }
    return null;
  }

  // No lock file, but a server can still be serving this directory — one
  // started outside Paperclip, or one whose lock file was deleted.
  if (existsSync(path.resolve(dataDir, "PG_VERSION")) && (await isPortInUse(preferredPort))) {
    try {
      if (await isServingDataDirectory(preferredPort, dataDir)) {
        const connection = await adoptCluster(preferredPort);
        process.emitWarning(
          `Adopting the existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} ` +
            `because ${POSTMASTER_LOCK_FILE_NAME} is missing.`,
        );
        return connection;
      }
    } catch {
      // Not ours, or not reachable — fall through and start our own cluster.
    }
  }

  return null;
}

async function ensureEmbeddedPostgresConnection(
  dataDir: string,
  preferredPort: number,
): Promise<MigrationConnection> {
  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  await prepareEmbeddedPostgresNativeRuntime();

  const running = await resolveRunningCluster(dataDir, preferredPort);
  if (running) return running;

  // The data directory is unowned, so a different port can only collide with an
  // unrelated service, never with our own cluster.
  const selectedPort = await findAvailablePort(preferredPort);
  const logBuffer = createEmbeddedPostgresLogBuffer();
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

  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL on port ${selectedPort}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  await waitForPostgresReady(adminConnectionString(selectedPort));
  await ensurePostgresDatabase(adminConnectionString(selectedPort), "paperclip");

  return {
    connectionString: databaseConnectionString(selectedPort),
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
