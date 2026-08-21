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
  canonicalizeDataDirectory,
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

/**
 * How long to wait for a server that already holds the port to identify itself.
 * Short on purpose: something is listening, so this only has to outlast a socket
 * that is still binding or a backend replaying WAL, not a cold start.
 */
const IDENTIFY_TIMEOUT_MS = 3_000;

/**
 * Whether the server answering on `port` is serving exactly `dataDir`.
 *
 * The readiness wait is not optional. `getPostgresDataDirectory` swallows every
 * error and returns null, so a postmaster of ours replaying WAL answers 57P03
 * and reads as "not ours" — after which the caller starts a second postmaster
 * over the live directory. That is the failure this module exists to prevent,
 * so identify the server only once it can answer.
 */
async function isServingDataDirectory(port: number, dataDir: string): Promise<boolean> {
  await waitForPostgresReady(adminConnectionString(port), { timeoutMs: IDENTIFY_TIMEOUT_MS });
  const actualDataDir = await getPostgresDataDirectory(adminConnectionString(port));
  return (
    typeof actualDataDir === "string" &&
    canonicalizeDataDirectory(actualDataDir) === canonicalizeDataDirectory(dataDir)
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
 * Attach to a cluster that is already serving `dataDir`, waiting out WAL
 * recovery first, and hand back a connection whose `stop` is a no-op — we did
 * not start this postmaster, so we must not stop it.
 */
async function adoptCluster(port: number, expectedDataDir: string): Promise<MigrationConnection> {
  await waitForPostgresReady(adminConnectionString(port));

  // A recorded port is not proof of identity. If an unrelated PostgreSQL now
  // occupies it, adopting blindly would create our database and run migrations
  // against someone else's cluster while the intended directory stays unresolved.
  const actualDataDir = await getPostgresDataDirectory(adminConnectionString(port));
  if (
    typeof actualDataDir !== "string" ||
    canonicalizeDataDirectory(actualDataDir) !== canonicalizeDataDirectory(expectedDataDir)
  ) {
    throw new Error(
      `PostgreSQL on port ${port} serves ${actualDataDir ?? "an unreported data directory"}, ` +
        `not ${path.resolve(expectedDataDir)}; refusing to adopt an unrelated cluster.`,
    );
  }

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
    return await adoptCluster(port, dataDir);
  }

  if (inspected.status === "indeterminate") {
    const port = inspected.lock?.port ?? preferredPort;
    try {
      const connection = await adoptCluster(port, dataDir);
      process.emitWarning(
        `Adopted the PostgreSQL server on port ${port} for ${dataDir} after an inconclusive lock-file check.`,
      );
      return connection;
    } catch (error) {
      // adoptCluster fails for three different reasons — the readiness deadline,
      // the data-directory identity check, and ensurePostgresDatabase. Asserting
      // "no server answered" would misreport the latter two and point the
      // operator at the wrong remedy, so surface what actually happened.
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Embedded PostgreSQL data directory ${dataDir} holds a ${POSTMASTER_LOCK_FILE_NAME} that cannot be ` +
          `adjudicated (${inspected.reason}), and the server on port ${port} could not be adopted: ${cause}. ` +
          `Refusing to start a second postmaster over live data. Stop any PostgreSQL still using this ` +
          `directory, then retry.`,
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
      return null;
    }
    // removeStalePostmasterLock re-inspects before deleting, so a refusal here
    // means the directory was claimed between our check and the removal. Falling
    // through would hand the caller a "nothing owns this" verdict that is no
    // longer true, and it would start a second postmaster over live data.
    throw new Error(
      `Embedded PostgreSQL data directory ${dataDir} appeared unowned, but ${POSTMASTER_LOCK_FILE_NAME} could ` +
        `not be removed (${removal.reason}). Refusing to start a second postmaster. Stop any PostgreSQL still ` +
        `using this directory, then retry.`,
    );
  }

  // No lock file, but a server can still be serving this directory — one
  // started outside Paperclip, or one whose lock file was deleted.
  if (existsSync(path.resolve(dataDir, "PG_VERSION")) && (await isPortInUse(preferredPort))) {
    let servesThisDirectory: boolean;
    try {
      servesThisDirectory = await isServingDataDirectory(preferredPort, dataDir);
    } catch (error) {
      // Something holds the port but would not identify itself in time. It may
      // be our own postmaster still replaying WAL, so this is precisely the case
      // where starting a second one destroys data. Swallowing this and falling
      // through to the port fallback is what kept the original bug reachable.
      throw new Error(
        `Port ${preferredPort} is in use, but the server there did not become ready, so ownership ` +
          `of ${dataDir} could not be established. Refusing to start a second postmaster over ` +
          `possibly-live data. Stop whatever is using port ${preferredPort}, or point the instance ` +
          `at a different port, then retry.`,
        { cause: error },
      );
    }

    if (servesThisDirectory) {
      // Ownership is proven, so a failure to adopt is fatal rather than a reason
      // to start a rival postmaster over the same directory.
      const connection = await adoptCluster(preferredPort, dataDir);
      process.emitWarning(
        `Adopting the existing PostgreSQL instance on port ${preferredPort} for embedded data dir ${dataDir} ` +
          `because ${POSTMASTER_LOCK_FILE_NAME} is missing.`,
      );
      return connection;
    }
    // Identified as a different cluster: our directory is unowned, so the caller
    // may start on another port.
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
