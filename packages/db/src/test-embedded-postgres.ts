import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyPendingMigrations, closeRegisteredClients, ensurePostgresDatabase } from "./client.js";
import {
  createEmbeddedPostgresLogBuffer,
  formatEmbeddedPostgresError,
} from "./embedded-postgres-error.js";
import { prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";
import { loadWithoutEmbeddedPostgresExitHooks } from "./embedded-postgres-lifecycle.js";
import { ownTestPostgres, TestPostgresShutdownError, type TestPostgresInstance } from "./test-postgres-owner.js";
import { checkTestPostgresAdmin, startTestPostgresDatabase, testPostgresAdminUrl } from "./test-postgres-admin.js";

// Time budget (ms) for a vitest test in the embedded-Postgres cost class: a
// test that starts an embedded Postgres cluster and runs migrations. Measured
// evidence: this cost class normally finishes in well under 10s. Under a
// contended CI runner the same test took up to 4.9x longer. This budget
// gives about 10x headroom over the clean time, so a contended run still
// passes while a genuine hang still fails fast.
export const EMBEDDED_POSTGRES_TEST_TIMEOUT_MS = 90_000;

type EmbeddedPostgresInstance = ReturnType<typeof ownTestPostgres>;

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => TestPostgresInstance;

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
  const mod = await loadWithoutEmbeddedPostgresExitHooks(() => import("embedded-postgres"));
  await prepareEmbeddedPostgresNativeRuntime();
  return mod.default as unknown as EmbeddedPostgresCtor;
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
  try {
    return await createEmbeddedPostgresTestInstanceAt(dataDir);
  } catch (error) {
    await cleanupEmbeddedPostgresTestDirs(dataDir);
    throw error;
  }
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
  const instance = ownTestPostgres(new EmbeddedPostgres({
    databaseDir: dataDir,
    user: EMBEDDED_POSTGRES_USER,
    password: EMBEDDED_POSTGRES_PASSWORD,
    port,
    persistent: true,
    initdbFlags: EMBEDDED_POSTGRES_INITDB_FLAGS,
    onLog: (message) => logBuffer.append(message),
    onError: (message) => logBuffer.append(message),
  }), dataDir);

  return { dataDir, port, instance, getRecentLogs: () => logBuffer.getRecentLogs() };
}

function adminConnectionStringFor(port: number): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/postgres`;
}

function databaseConnectionStringFor(port: number): string {
  return `postgres://${EMBEDDED_POSTGRES_USER}:${EMBEDDED_POSTGRES_PASSWORD}@127.0.0.1:${port}/paperclip`;
}

async function cleanupEmbeddedPostgresTestDirs(dataDir: string): Promise<void> {
  if (process.platform !== "win32") {
    try {
      await promisify(execFile)("/bin/rm", ["-rf", "--", dataDir], { maxBuffer: 64 * 1024 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.promises.rm(dataDir, { recursive: true, force: true });
}

async function stopEmbeddedPostgresBounded(
  instance: EmbeddedPostgresInstance | null,
  cleanupFn?: () => Promise<void>,
): Promise<void> {
  await instance?.stop();
  await cleanupFn?.();
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
      if (!/address already in use/i.test(lastError.message)) throw lastError;
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
// A template is a Postgres data directory, and starting one executes its
// configuration (for example `shared_preload_libraries`). The cache root is
// therefore private to the current OS user: its name carries the user id, it
// is created with mode 0700, and it is only used when it is a real directory
// (not a symlink) owned by this user with no group or world write bit. Each
// template is checked the same way before it is copied. On a host with a
// shared temp directory another user can pre-create the predictable path, and
// those checks reject it. Windows has no uid; its temp directory is already
// per user, so the ownership and mode checks are skipped there.
//
// Set PAPERCLIP_TEST_POSTGRES_TEMPLATE=0 to bypass the cache and run the fresh
// path for every suite. Any failure on the template path (root checks, build,
// copy, start, or publish) falls back to the fresh path, so a broken cache can
// make a suite slower but never fail it or skip it: the fresh path still
// reports a migration that cannot apply or a cluster that cannot start.
// ---------------------------------------------------------------------------

const TEMPLATE_ROOT_DIR_NAME = "paperclip-embedded-postgres-templates";
// Templates whose key no longer matches are pruned once they have not been
// used for this long. Every reuse refreshes the template's timestamp.
const TEMPLATE_PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

// The uid on POSIX, else the user name. Part of the cache root's name so two
// users on one host never share a root.
function templateOwnerTag(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  let username = "user";
  try {
    username = os.userInfo().username;
  } catch {
    // Fall through to the generic tag.
  }
  return username.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function templateRootDir(): string {
  return path.join(os.tmpdir(), `${TEMPLATE_ROOT_DIR_NAME}-${templateOwnerTag()}`);
}

// Why `dir` cannot be trusted as a private directory of the current user, or
// null when it can. Uses `lstat` so a symlink planted at the path is rejected
// rather than followed. On Windows (no uid) only the directory check applies.
function describePrivateDirectoryProblem(dir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    return `cannot be inspected (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
  }
  if (stat.isSymbolicLink()) return "is a symbolic link";
  if (!stat.isDirectory()) return "is not a directory";
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  if (stat.uid !== uid) return `is owned by uid ${stat.uid}, not the current user (uid ${uid})`;
  if ((stat.mode & 0o022) !== 0) {
    return `is writable by group or others (mode ${(stat.mode & 0o777).toString(8)})`;
  }
  return null;
}

// Creates the cache root with mode 0700 and verifies it is private to the
// current user. Returns null, after one warning, when it is not: the cache is
// then unused for this process and every suite takes the fresh path.
function prepareTemplateRootDir(): string | null {
  const rootDir = templateRootDir();
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    const problem = describePrivateDirectoryProblem(rootDir);
    if (problem !== null) {
      warnTemplateOnce("root", `template cache root ${rootDir} ${problem}; using fresh clusters`);
      return null;
    }
    // A root created by an earlier version may be wider than 0700. It is
    // ours (checked above), so narrow it.
    if (process.getuid !== undefined && (fs.lstatSync(rootDir).mode & 0o777) !== 0o700) {
      fs.chmodSync(rootDir, 0o700);
    }
    return rootDir;
  } catch (error) {
    warnTemplateOnce(
      "root",
      `template cache root ${rootDir} could not be prepared: ${(error as Error).message}; using fresh clusters`,
    );
    return null;
  }
}

// A template is usable when it is a private directory of the current user
// that holds a cleanly stopped cluster: `PG_VERSION` present, no
// `postmaster.pid`. The ownership check repeats the root's check so a
// template is never copied from a directory this user does not own.
function isUsableTemplate(dir: string): boolean {
  if (describePrivateDirectoryProblem(dir) !== null) return false;
  return fs.existsSync(path.join(dir, "PG_VERSION")) && !fs.existsSync(path.join(dir, "postmaster.pid"));
}

// Records a use of the template so `pruneStaleTemplates` measures idle time,
// not age. Best effort.
function touchTemplate(dir: string): void {
  try {
    const now = new Date();
    fs.utimesSync(dir, now, now);
  } catch {
    // The template still works without the refreshed timestamp.
  }
}

const warnedTemplateTopics = new Set<string>();

function warnTemplateOnce(topic: string, message: string): void {
  if (warnedTemplateTopics.has(topic)) return;
  warnedTemplateTopics.add(topic);
  console.warn(`[embedded-postgres] ${message}`);
}

// Best-effort removal of templates for other keys that have not been used for
// a week, plus abandoned build directories. Every reuse refreshes a template's
// timestamp, so a template that any process resolved in the last week stays.
// A suite never depends on the template after its copy is made, so pruning
// can only affect a process that resolved the path and has not copied yet;
// that process then rebuilds the template instead of failing. Never throws.
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
  try {
    await instance.stopGracefully();
    return true;
  } catch { return false; }
}

// Builds a migrated cluster and publishes its data directory at `templateDir`.
// Throws when the cluster cannot start or a migration cannot apply. Returns
// false when the cluster started but the template could not be published;
// callers then use the fresh path for this process.
async function buildEmbeddedPostgresTemplate(templateDir: string): Promise<boolean> {
  const rootDir = path.dirname(templateDir);
  const { port, dataDir, instance } = await startEmbeddedPostgresWithRetry(
    "paperclip-embedded-postgres-template-build-",
  );
  let published = false;
  try {
    await ensurePostgresDatabase(adminConnectionStringFor(port), "paperclip");
    await applyPendingMigrations(databaseConnectionStringFor(port));
    const stopped = await stopForTemplatePublish(instance);
    if (!stopped || !isUsableTemplate(dataDir)) return false;
    try {
      fs.renameSync(dataDir, templateDir);
      published = true;
    } catch (error) {
      // Another process published the same key first. Use theirs.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") {
        return isUsableTemplate(templateDir);
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

async function getEmbeddedPostgresTemplateDir(): Promise<string | null> {
  if (isTemplateCacheDisabled()) return null;
  if (!templateDirPromise) {
    templateDirPromise = (async () => {
      const rootDir = prepareTemplateRootDir();
      if (rootDir === null) return null;
      const templateDir = path.join(rootDir, computeEmbeddedPostgresTemplateKey());
      if (isUsableTemplate(templateDir)) {
        touchTemplate(templateDir);
        return templateDir;
      }
      try {
        const built = await buildEmbeddedPostgresTemplate(templateDir);
        return built && isUsableTemplate(templateDir) ? templateDir : null;
      } catch (error) {
        if (error instanceof TestPostgresShutdownError) throw error;
        warnTemplateOnce(
          "build",
          `template build failed, using fresh clusters: ${(error as Error).message}`,
        );
        return null;
      }
    })();
  }
  return await templateDirPromise;
}

// Forgets the resolved template so the next caller in this process checks the
// cache again. Used after a template start failed, for example because the
// template was pruned by another process after this one resolved its path.
function resetTemplateDirCache(): void {
  templateDirPromise = null;
}

// Copies the template and starts a cluster on the copy. Each attempt uses a
// fresh copy and a fresh port, mirroring `startEmbeddedPostgresWithRetry`. A
// template that is no longer usable (pruned, or no longer private) is not
// retried: the caller falls back and the next caller rebuilds it.
async function startEmbeddedPostgresFromTemplateWithRetry(
  templateDir: string,
  tempDirPrefix: string,
): Promise<{ port: number; dataDir: string; instance: EmbeddedPostgresInstance }> {
  let lastError = new Error("embedded Postgres startup from template failed");

  for (let attempt = 1; attempt <= EMBEDDED_POSTGRES_START_MAX_ATTEMPTS; attempt += 1) {
    if (!isUsableTemplate(templateDir)) {
      throw new Error(`embedded Postgres template ${templateDir} is no longer usable`);
    }
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
      if (!/address already in use/i.test(lastError.message)) throw lastError;
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
export const __isUsableEmbeddedPostgresTemplateForTests = isUsableTemplate;
export function __lastEmbeddedPostgresStartModeForTests(): EmbeddedPostgresStartMode | null {
  return lastStartMode;
}
// Forgets the support probe result, the resolved template, and the one-time
// warnings so a test can drive the probe and the cache again in one process.
export function __resetEmbeddedPostgresTemplateStateForTests(): void {
  embeddedPostgresSupportPromise = null;
  templateDirPromise = null;
  templateFallbackWarned = false;
  warnedTemplateTopics.clear();
  lastStartMode = null;
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  if ((await getEmbeddedPostgresTemplateDir()) !== null) return { supported: true };

  let started: { dataDir: string; instance: EmbeddedPostgresInstance } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    const failure = formatEmbeddedPostgresError(error, {
      fallbackMessage: "embedded Postgres startup failed",
    });
    if (/Unsupported (?:arch|platform) "/.test(failure.message)) {
      return { supported: false, reason: failure.message };
    }
    throw failure;
  } finally {
    if (started) {
      const { dataDir, instance } = started;
      await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
    }
  }
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  const adminUrl = testPostgresAdminUrl();
  if (adminUrl) {
    await checkTestPostgresAdmin(adminUrl);
    return { supported: true };
  }
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
  const templateDir = await getEmbeddedPostgresTemplateDir();

  if (templateDir !== null) {
    try {
      const started = await startEmbeddedPostgresFromTemplateWithRetry(templateDir, tempDirPrefix);
      return { ...started, mode: "template" };
    } catch (error) {
      if (error instanceof TestPostgresShutdownError) throw error;
      // The next caller in this process re-resolves the template: if it was
      // pruned it is rebuilt, instead of retrying a path that is gone.
      resetTemplateDirCache();
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
  const adminUrl = testPostgresAdminUrl();
  if (adminUrl) return startTestPostgresDatabase(adminUrl);
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
        try { await closeRegisteredClients(connectionString); }
        finally {
          await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
        }
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
