import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingMigrations, closeRegisteredClients, ensurePostgresDatabase } from "./client.js";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

// Time budget (ms) for a vitest test in the embedded-Postgres cost class: a
// test that starts an embedded Postgres cluster and runs migrations. Measured
// evidence: this cost class normally finishes in well under 10s. Under a
// contended CI runner the same test took up to 4.9x longer. This budget
// gives about 10x headroom over the clean time, so a contended run still
// passes while a genuine hang still fails fast.
export const EMBEDDED_POSTGRES_TEST_TIMEOUT_MS = 90_000;

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

const EMBEDDED_POSTGRES_USER = "paperclip";
const EMBEDDED_POSTGRES_PASSWORD = "paperclip";
const EMBEDDED_POSTGRES_INITDB_FLAGS = ["--encoding=UTF8", "--locale=C", "--lc-messages=C"];

async function createEmbeddedPostgresTestInstance(tempDirPrefix: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
  return await createEmbeddedPostgresTestInstanceAt(dataDir);
}

// Wraps an embedded-postgres instance around `dataDir`. The caller decides
// whether the directory still needs `initialise()` (a fresh cluster) or already
// holds a copied cluster that only needs `start()`.
async function createEmbeddedPostgresTestInstanceAt(dataDir: string) {
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  // Postgres writes the true reason for a failed start to its output, for
  // example `could not bind IPv4 address "127.0.0.1": Address already in use`.
  // The `start()` rejection carries an empty message, so we capture the output
  // in a bounded buffer and surface it in the thrown error.
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: EMBEDDED_POSTGRES_USER,
    password: EMBEDDED_POSTGRES_PASSWORD,
    port,
    persistent: true,
    initdbFlags: EMBEDDED_POSTGRES_INITDB_FLAGS,
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  });

  return { dataDir, port, instance, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function adminConnectionStringFor(port: number): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/postgres`;
}

function databaseConnectionStringFor(port: number): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/paperclip`;
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

// ---------------------------------------------------------------------------
// Template cluster cache
//
// Every suite that calls `startEmbeddedPostgresTestDatabase` used to pay for
// `initdb`, a cluster start, and all pending migrations (331 files at the time
// of writing) before its first test ran, and the `getEmbeddedPostgresTestSupport`
// probe started and stopped a second throwaway cluster per test file. On the
// serial CI shards that was 5-6s per suite plus 2.5-3s per probe; measured
// locally it is 3.2s per suite plus 0.75s per probe.
//
// A cluster data directory that was shut down cleanly can be copied and started
// again as an independent cluster. So the first caller on a host builds one
// fully migrated cluster, stops it, and publishes the data directory as a
// template under the OS temp directory. Every later caller copies the template
// (about 90 MB, ~0.2s) and starts Postgres on the copy (~0.05s), then still runs
// `ensurePostgresDatabase` and `applyPendingMigrations` so the returned database
// is exactly what the fresh path produces; both are no-ops on a template copy.
//
// The template key hashes everything that determines the cluster's contents:
// the embedded-postgres package version, the initdb flags, the user, and the
// name and content of every migration file plus the journal. A changed
// migration therefore builds a new template instead of reusing a stale one.
// Publishing is a rename, which is atomic on the same filesystem, so a
// concurrent builder either wins the rename or discards its copy and uses the
// winner's; a template that exists is always complete.
//
// Set PAPERCLIP_TEST_POSTGRES_TEMPLATE=0 to bypass the cache and run the fresh
// path for every suite. Any failure on the template path (copy, start, or
// publish) falls back to the fresh path, so a broken cache cannot fail a suite
// that would otherwise pass.
// ---------------------------------------------------------------------------

const TEMPLATE_ROOT_DIR_NAME = "paperclip-embedded-postgres-templates";
// Templates whose key no longer matches are pruned once they are this old.
const TEMPLATE_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Publishing a template requires the builder cluster to have exited for real,
// so its data files are quiescent before the rename. Give that stop more room
// than the per-suite bounded stop; a template build happens once per host.
const TEMPLATE_BUILD_STOP_TIMEOUT_MS = 30_000;

export type EmbeddedPostgresStartMode = "template" | "fresh";

function isTemplateCacheDisabled(): boolean {
  return process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE === "0";
}

function migrationsDirectory(): string {
  return fileURLToPath(new URL("./migrations/", import.meta.url));
}

function embeddedPostgresPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require("embedded-postgres/package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Hash of everything that determines the contents of a migrated cluster. Reads
// every migration file, which costs a few milliseconds per process.
export function computeEmbeddedPostgresTemplateKey(
  migrationsDir: string = migrationsDirectory(),
  input: { packageVersion?: string; initdbFlags?: string[]; user?: string } = {},
): string {
  const hash = createHash("sha256");
  hash.update(`embedded-postgres=${input.packageVersion ?? embeddedPostgresPackageVersion()}\n`);
  hash.update(`initdb=${(input.initdbFlags ?? EMBEDDED_POSTGRES_INITDB_FLAGS).join(" ")}\n`);
  hash.update(`user=${input.user ?? EMBEDDED_POSTGRES_USER}\n`);
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  if (fs.existsSync(journalPath)) {
    hash.update(`journal\n`);
    hash.update(fs.readFileSync(journalPath));
    hash.update(`\n`);
  }
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
  for (const name of migrationFiles) {
    hash.update(`${name}\n`);
    hash.update(fs.readFileSync(path.join(migrationsDir, name)));
    hash.update(`\n`);
  }
  return hash.digest("hex").slice(0, 24);
}

function templateRootDir(): string {
  return path.join(os.tmpdir(), TEMPLATE_ROOT_DIR_NAME);
}

function isCompleteTemplate(dir: string): boolean {
  return fs.existsSync(path.join(dir, "PG_VERSION")) && !fs.existsSync(path.join(dir, "postmaster.pid"));
}

// Best-effort removal of templates for other keys that have not been touched
// for a week, plus abandoned build directories. Never throws.
function pruneStaleTemplates(rootDir: string, keepDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entryPath === keepDir || !entry.isDirectory()) continue;
    try {
      const age = now - fs.statSync(entryPath).mtimeMs;
      if (age > TEMPLATE_PRUNE_AGE_MS) fs.rmSync(entryPath, { recursive: true, force: true });
    } catch {
      // Another process may be using or removing it; leave it alone.
    }
  }
}

// Waits for the raw `stop()` so the builder cluster has really exited before
// its data directory is published. Returns false if the stop overran.
async function stopForTemplatePublish(instance: EmbeddedPostgresInstance): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      instance.stop().then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), TEMPLATE_BUILD_STOP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Builds a migrated cluster and publishes its data directory at `templateDir`.
// Throws the fresh-path error if the cluster cannot start at all, so the probe
// can report the real reason on an unsupported host. Returns false when the
// cluster started but the template could not be published; callers then use
// the fresh path for this process.
async function buildEmbeddedPostgresTemplate(templateDir: string): Promise<boolean> {
  const rootDir = path.dirname(templateDir);
  fs.mkdirSync(rootDir, { recursive: true });
  const { port, dataDir, instance } = await startEmbeddedPostgresWithRetry(
    "paperclip-embedded-postgres-template-build-",
  );
  let published = false;
  try {
    await ensurePostgresDatabase(adminConnectionStringFor(port), "paperclip");
    await applyPendingMigrations(databaseConnectionStringFor(port));
    const stopped = await stopForTemplatePublish(instance);
    if (!stopped || !isCompleteTemplate(dataDir)) return false;
    try {
      fs.renameSync(dataDir, templateDir);
      published = true;
    } catch (error) {
      // Another process published the same key first. Use theirs.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") {
        return isCompleteTemplate(templateDir);
      }
      throw error;
    }
    pruneStaleTemplates(rootDir, templateDir);
    return true;
  } finally {
    if (!published) {
      await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
    }
  }
}

let templateDirPromise: Promise<string | null> | null = null;

// Resolves the template data directory for this host, building it on first
// use. Resolves null when the cache is disabled or the template could not be
// published. Rejects only when a fresh cluster cannot start at all.
async function getEmbeddedPostgresTemplateDir(): Promise<string | null> {
  if (isTemplateCacheDisabled()) return null;
  if (!templateDirPromise) {
    templateDirPromise = (async () => {
      const templateDir = path.join(templateRootDir(), computeEmbeddedPostgresTemplateKey());
      if (isCompleteTemplate(templateDir)) return templateDir;
      try {
        const built = await buildEmbeddedPostgresTemplate(templateDir);
        return built && isCompleteTemplate(templateDir) ? templateDir : null;
      } catch (error) {
        // Let the next caller try again instead of pinning the failure.
        templateDirPromise = null;
        throw error;
      }
    })();
  }
  return await templateDirPromise;
}

// Copies the template and starts a cluster on the copy. Each attempt uses a
// fresh copy and a fresh port, mirroring `startEmbeddedPostgresWithRetry`.
async function startEmbeddedPostgresFromTemplateWithRetry(
  templateDir: string,
  tempDirPrefix: string,
): Promise<{ port: number; dataDir: string; instance: EmbeddedPostgresInstance }> {
  let lastError = new Error("embedded Postgres startup from template failed");

  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), tempDirPrefix));
    const dataDir = path.join(rootDir, "data");
    let created: Awaited<ReturnType<typeof createEmbeddedPostgresTestInstanceAt>> | null = null;
    try {
      fs.cpSync(templateDir, dataDir, { recursive: true });
      // Postgres refuses a data directory that is group or world accessible.
      fs.chmodSync(dataDir, 0o700);
      created = await createEmbeddedPostgresTestInstanceAt(dataDir);
      await created.instance.start();
      return { port: created.port, dataDir: rootDir, instance: created.instance };
    } catch (error) {
      lastError = formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup from template failed",
        recentLogs: created?.getRecentLogs(),
      });
      await stopEmbeddedPostgresBounded(created?.instance ?? null, () =>
        cleanupEmbeddedPostgresTestDirs(rootDir),
      );
    }
  }

  throw new Error(
    `Failed to start embedded PostgreSQL from template after ${EMBEDDED_POSTGRES_START_MAX_ATTEMPTS} attempts: ${lastError.message}`,
  );
}

let templateFallbackWarned = false;
let lastStartMode: EmbeddedPostgresStartMode | null = null;

// Test-only accessors. Production callers use `startEmbeddedPostgresTestDatabase`
// or `getEmbeddedPostgresTestSupport`. A test drives the bounded retry directly
// so it does not need a real Postgres connection.
export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;
export const __embeddedPostgresTemplateRootDirForTests = templateRootDir;
export function __lastEmbeddedPostgresStartModeForTests(): EmbeddedPostgresStartMode | null {
  return lastStartMode;
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  // A published template proves this host can run the cluster: it was built
  // here. Reusing it makes the probe free for every file after the first.
  // Building it costs one cluster start, the same as the throwaway probe did.
  try {
    if ((await getEmbeddedPostgresTemplateDir()) !== null) return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
      }).message,
    };
  }

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

// Starts the cluster for one suite: from the host template when one is
// available, otherwise a fresh `initdb`. Template failures fall back to the
// fresh path so the cache can only make a suite faster, never fail it.
async function startEmbeddedPostgresClusterForSuite(
  tempDirPrefix: string,
): Promise<{ port: number; dataDir: string; instance: EmbeddedPostgresInstance; mode: EmbeddedPostgresStartMode }> {
  let templateDir: string | null = null;
  try {
    templateDir = await getEmbeddedPostgresTemplateDir();
  } catch {
    // A fresh cluster could not start while building the template. The fresh
    // path below retries and throws the real reason if it fails again.
  }

  if (templateDir !== null) {
    try {
      const started = await startEmbeddedPostgresFromTemplateWithRetry(templateDir, tempDirPrefix);
      return { ...started, mode: "template" };
    } catch (error) {
      if (!templateFallbackWarned) {
        templateFallbackWarned = true;
        console.warn(
          `[embedded-postgres] template start failed, using a fresh cluster: ${(error as Error).message}`,
        );
      }
    }
  }

  // The bounded retry hardens the cluster start against the port race. It throws
  // with the real Postgres output if every attempt fails.
  const started = await startEmbeddedPostgresWithRetry(tempDirPrefix);
  return { ...started, mode: "fresh" };
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const { port, dataDir, instance, mode } = await startEmbeddedPostgresClusterForSuite(tempDirPrefix);
  lastStartMode = mode;

  try {
    // Both calls are no-ops on a template copy and keep the returned database
    // identical to the fresh path even if the template were ever stale.
    await ensurePostgresDatabase(adminConnectionStringFor(port), "paperclip");
    const connectionString = databaseConnectionStringFor(port);
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
