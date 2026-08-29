import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { applyPendingMigrations, closeRegisteredClients, ensurePostgresDatabase } from "./client.js";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

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

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

const DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT = 54329;

function getReservedTestPorts(): Set<number> {
  const configuredPorts = [
    DEFAULT_PAPERCLIP_EMBEDDED_POSTGRES_PORT,
    Number.parseInt(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT ?? "", 10),
    ...String(process.env.PAPERCLIP_TEST_POSTGRES_RESERVED_PORTS ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10)),
  ];
  return new Set(configuredPorts.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
}

type EmbeddedPostgresCtorProvider = () => Promise<EmbeddedPostgresCtor>;

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as EmbeddedPostgresCtor;
}

let embeddedPostgresCtorProvider: EmbeddedPostgresCtorProvider = loadEmbeddedPostgresCtor;

// Test seam. Replace the embedded-postgres constructor provider so a test can
// simulate a failed start without the native runtime. Pass `null` to restore
// the default provider. This module is test support only, so the seam is safe.
export function __setEmbeddedPostgresCtorProviderForTests(
  provider: EmbeddedPostgresCtorProvider | null,
): void {
  embeddedPostgresCtorProvider = provider ?? loadEmbeddedPostgresCtor;
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  return await embeddedPostgresCtorProvider();
}

async function getAvailablePort(): Promise<number> {
  const reservedPorts = getReservedTestPorts();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate test port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });

    if (!reservedPorts.has(port)) return port;
  }

  throw new Error(
    `Failed to allocate embedded Postgres test port outside reserved Paperclip ports: ${[
      ...reservedPorts,
    ].join(", ")}`,
  );
}

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  // Postgres writes the true reason for a failed start to its output, for
  // example `could not bind IPv4 address "127.0.0.1": Address already in use`.
  // The `start()` rejection carries an empty message, so we capture the output
  // in a bounded buffer and surface it in the thrown error.
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  });

  return { dataDir, port, instance, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function cleanupEmbeddedPostgresTestDirs(dataDir: string) {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

// Upper bound (ms) on how long we wait for the embedded Postgres cluster to
// stop gracefully before abandoning the wait and returning from the hook.
const EMBEDDED_POSTGRES_STOP_TIMEOUT_MS = 5000;

// `embedded-postgres@18.1.0-beta.16` exposes only `stop(): Promise<void>` — no
// shutdown-mode argument. Internally it SIGINTs the postgres process (already
// PostgreSQL "fast shutdown") and resolves *only* on the child's `exit` event,
// with no time bound of its own. Under the loaded serial server shard a slow
// shutdown checkpoint can push that past vitest's hookTimeout and hang the
// afterAll hook. So we bound the graceful stop: if it overruns, we stop waiting
// and return so the hook completes. The SIGINT has already been delivered, so
// the abandoned process still exits on its own (and again when the runner exits).
// Errors are swallowed, matching prior behavior.
//
// `cleanupFn` (data-dir reclaim) is chained on the raw `stop()` promise, not on
// the timeout race, so the disposable data dir is removed *only after* `stop()`
// actually settles — i.e. once the child Postgres process has exited. Removing
// it on the timeout path would pull the data files out from under a still-running
// cluster and provoke checkpoint / WAL I/O errors. In the fast path `cleanupFn`
// has run by the time this resolves; in the timeout path it runs asynchronously
// once the abandoned process finally exits.
async function stopEmbeddedPostgresBounded(
  instance: EmbeddedPostgresInstance | null,
  cleanupFn?: () => void,
): Promise<void> {
  if (!instance) {
    cleanupFn?.();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = instance
    .stop()
    .catch(() => {
      // Swallow shutdown errors — the data dir is reclaimed regardless.
    })
    .finally(() => {
      try {
        cleanupFn?.();
      } catch {
        // Best-effort reclaim; ignore removal errors.
      }
    });
  try {
    await Promise.race([
      stopped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, EMBEDDED_POSTGRES_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Upper bound on start attempts. `getAvailablePort` uses a check-then-use probe:
// it binds port 0, reads the assigned port, closes the probe, then Postgres binds
// that port. Under load another process can take the port in that window, so the
// bind fails with "Address already in use" and `start()` rejects. Each retry uses
// a fresh port and a fresh data directory, so a transient collision clears.
const EMBEDDED_POSTGRES_START_MAX_ATTEMPTS = 5;

// Start one embedded Postgres cluster with a bounded retry. Each attempt gets a
// fresh port and a fresh data directory. On a failed attempt we stop the cluster
// and remove its data directory before the next attempt. After the last attempt
// we throw with the real Postgres output so the failure is loud and diagnosable.
async function startEmbeddedPostgresWithRetry(tempDirPrefix: string): Promise<{
  port: number;
  dataDir: string;
  instance: EmbeddedPostgresInstance;
}> {
  let lastError = new Error("embedded Postgres startup failed");

  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    const created = await createEmbeddedPostgresTestInstance(tempDirPrefix);
    try {
      await created.instance.initialise();
      await created.instance.start();
      return { port: created.port, dataDir: created.dataDir, instance: created.instance };
    } catch (error) {
      lastError = formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
        recentLogs: created.getRecentLogs(),
      });
      // Stop the failed cluster and remove its data directory. The next attempt
      // allocates a fresh port and a fresh data directory.
      await stopEmbeddedPostgresBounded(created.instance, () =>
        cleanupEmbeddedPostgresTestDirs(created.dataDir),
      );
    }
  }

  throw new Error(
    `Failed to start embedded PostgreSQL test database after ${EMBEDDED_POSTGRES_START_MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

// Test-only accessors. Production callers use `startEmbeddedPostgresTestDatabase`
// or `getEmbeddedPostgresTestSupport`. A test drives the bounded retry directly
// so it does not need a real Postgres connection.
export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  let started: { dataDir: string; instance: EmbeddedPostgresInstance } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
      }).message,
    };
  } finally {
    if (started) {
      const { dataDir, instance } = started;
      await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
    }
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  return await embeddedPostgresSupportPromise;
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  // The bounded retry hardens the cluster start against the port race. It throws
  // with the real Postgres output if every attempt fails.
  const { port, dataDir, instance } = await startEmbeddedPostgresWithRetry(tempDirPrefix);

  try {
    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        // End every client a caller created against this cluster first. A
        // client that still holds a reserved connection when the cluster
        // stops can crash the process: the stop kills the backend socket,
        // but a queued write on that connection still fires later and finds
        // a null socket.
        await closeRegisteredClients(connectionString);
        await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
      },
    };
  } catch (error) {
    await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${
        formatEmbeddedPostgresError(error, {
          fallbackMessage: "embedded Postgres startup failed",
        }).message
      }`,
    );
  }
}
