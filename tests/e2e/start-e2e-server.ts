import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPendingMigrations,
  closeRegisteredClients,
  createDb,
  ensurePostgresDatabase,
} from "../../packages/db/src/client.js";
import { loadWithoutEmbeddedPostgresExitHooks } from "../../packages/db/src/embedded-postgres-lifecycle.js";
import { prepareEmbeddedPostgresNativeRuntime } from "../../packages/db/src/embedded-postgres-native.js";
import {
  computeEmbeddedPostgresTemplateKey,
  startEmbeddedPostgresTestDatabase,
} from "../../packages/db/src/test-embedded-postgres.js";
import {
  beforeTestPostgresShutdown,
  ownTestPostgres,
  type TestPostgresInstance,
} from "../../packages/db/src/test-postgres-owner.js";

// Fast throwaway server bootstrap for Playwright E2E shards.
// Replaces `cli onboard --yes --run` (and avoids building/copying a durable
// template cluster on ephemeral CI runners where only one server boots per job):
//   1. Writes the minimal throwaway local_trusted config + secrets key directly.
//   2. Boots a single disposable embedded Postgres with `initdb --no-sync` and
//      non-durable settings (`fsync=off`, `synchronous_commit=off`,
//      `full_page_writes=off`, `autovacuum=off`) written to `postgresql.conf`
//      BEFORE `start()`, so all migrations and E2E test writes run at memory
//      speed without stop/copy/restart overhead.
//   3. Overlaps `import("../../server/src/index.js")` with Postgres bootstrap
//      and starts `server/src/index.ts` directly via `startServer()`.

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

type DisposableDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

const EMBEDDED_USER = "paperclip";
const EMBEDDED_PASSWORD = "paperclip";
const EMBEDDED_DB = "paperclip";
const INITDB_FLAGS = ["--encoding=UTF8", "--locale=C", "--lc-messages=C", "--no-sync"];
const DISPOSABLE_PG_CONF = [
  "",
  "# Disposable E2E test cluster tuning — zero crash durability required",
  "fsync = off",
  "synchronous_commit = off",
  "full_page_writes = off",
  "autovacuum = off",
  "checkpoint_timeout = 1h",
  "max_wal_size = 1GB",
  "maintenance_work_mem = 128MB",
  "work_mem = 32MB",
  "log_min_messages = warning",
  "",
].join("\n");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UI_BUILD_ARGS = [
  "ui/node_modules/vite/bin/vite.js",
  "build",
  "ui",
  "--outDir",
  "../server/ui-dist",
  "--emptyOutDir",
  "--minify",
  "false",
];

function startParallelUiBuild(): { child: ChildProcess; done: Promise<void> } | null {
  if (process.env.PAPERCLIP_E2E_BUILD_UI !== "1") return null;
  const child = spawn(process.execPath, UI_BUILD_ARGS, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `E2E UI build failed (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
        ),
      );
    });
  });
  done.catch(() => {});
  return { child, done };
}

const MAX_START_ATTEMPTS = 5;

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate E2E Postgres port")));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const mod = await loadWithoutEmbeddedPostgresExitHooks(async () => {
    const loaded = dbRequire("embedded-postgres") as { default?: EmbeddedPostgresCtor } | EmbeddedPostgresCtor;
    return typeof loaded === "function" ? loaded : loaded.default;
  });
  if (!mod) {
    throw new Error("Failed to load embedded-postgres constructor from @paperclipai/db");
  }
  await prepareEmbeddedPostgresNativeRuntime();
  return mod;
}

type FastPostgresHandle = {
  ready: Promise<DisposableDatabase>;
};

async function startFastDisposablePostgres(
  EmbeddedPostgres: EmbeddedPostgresCtor,
): Promise<FastPostgresHandle> {
  // Allocate port and kick off `initdb` BEFORE returning so the `initdb` child
  // process runs in parallel on another core while the caller concurrently
  // transpiles `server/src/index.ts` via `tsx`.
  const firstDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-pg-"));
  const firstPort = await getAvailablePort();

  const attemptStart = async (
    dataDir: string,
    pgPort: number,
    preStartedInit?: Promise<void>,
    preOwnedInstance?: ReturnType<typeof ownTestPostgres>,
    preLogs?: string[],
  ): Promise<DisposableDatabase> => {
    const recentLogs = preLogs ?? [];
    const appendLog = (message: unknown) => {
      const text = String(message ?? "").trim();
      if (!text) return;
      recentLogs.push(text);
      if (recentLogs.length > 40) recentLogs.shift();
    };
    const instance =
      preOwnedInstance ??
      ownTestPostgres(
        new EmbeddedPostgres({
          databaseDir: dataDir,
          user: EMBEDDED_USER,
          password: EMBEDDED_PASSWORD,
          port: pgPort,
          persistent: true,
          initdbFlags: INITDB_FLAGS,
          onLog: appendLog,
          onError: appendLog,
        }),
        dataDir,
      );

    try {
      await (preStartedInit ?? instance.initialise());
      fs.appendFileSync(path.join(dataDir, "postgresql.conf"), DISPOSABLE_PG_CONF, "utf8");
      await instance.start();

      const adminUrl = `postgres://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@127.0.0.1:${pgPort}/postgres`;
      const connectionString = `postgres://${EMBEDDED_USER}:${EMBEDDED_PASSWORD}@127.0.0.1:${pgPort}/${EMBEDDED_DB}`;
      await ensurePostgresDatabase(adminUrl, EMBEDDED_DB);
      await applyPendingMigrations(connectionString);

      let cleaned = false;
      return {
        connectionString,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          try {
            await closeRegisteredClients(connectionString).catch(() => {});
          } finally {
            await instance.stop().catch(() => {});
            await fs.promises.rm(dataDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      try {
        await instance.stop();
      } catch {
        // Ignore stop error on failed start attempt.
      }
      await fs.promises.rm(dataDir, { recursive: true, force: true });
      const combined = `${error instanceof Error ? error.message : String(error)}\n${recentLogs.join("\n")}`;
      if (!/address already in use/i.test(combined)) {
        throw new Error(`Fast E2E embedded Postgres startup failed: ${combined}`);
      }
      throw error;
    }
  };

  const firstLogs: string[] = [];
  const appendFirstLog = (message: unknown) => {
    const text = String(message ?? "").trim();
    if (!text) return;
    firstLogs.push(text);
    if (firstLogs.length > 40) firstLogs.shift();
  };
  const firstInstance = ownTestPostgres(
    new EmbeddedPostgres({
      databaseDir: firstDataDir,
      user: EMBEDDED_USER,
      password: EMBEDDED_PASSWORD,
      port: firstPort,
      persistent: true,
      initdbFlags: INITDB_FLAGS,
      onLog: appendFirstLog,
      onError: appendFirstLog,
    }),
    firstDataDir,
  );
  // Spawns the `initdb` child process synchronously before returning.
  const firstInitPromise = firstInstance.initialise();

  const ready = (async () => {
    let lastError: unknown = new Error("embedded Postgres startup failed");
    try {
      return await attemptStart(firstDataDir, firstPort, firstInitPromise, firstInstance, firstLogs);
    } catch (error) {
      lastError = error;
      if (!/address already in use/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
    for (let attempt = 2; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-pg-"));
      const pgPort = await getAvailablePort();
      try {
        return await attemptStart(dataDir, pgPort);
      } catch (error) {
        lastError = error;
        if (!/address already in use/i.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  })();

  return { ready };
}

const port = Number(process.env.PORT ?? process.env.PAPERCLIP_E2E_PORT ?? 3199);
const instanceId = process.env.PAPERCLIP_INSTANCE_ID ?? "playwright-e2e";
const homeDir =
  process.env.PAPERCLIP_HOME ??
  fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-home-"));
const instanceRoot = path.join(homeDir, "instances", instanceId);
const configPath =
  process.env.PAPERCLIP_CONFIG ?? path.join(instanceRoot, "config.json");
const logsDir = path.join(instanceRoot, "logs");
const storageDir = path.join(instanceRoot, "data", "storage");
const masterKeyPath = path.join(instanceRoot, "secrets", "master.key");

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(path.dirname(masterKeyPath), { recursive: true });
fs.mkdirSync(path.dirname(configPath), { recursive: true });

if (!fs.existsSync(masterKeyPath)) {
  fs.writeFileSync(masterKeyPath, randomBytes(32).toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
  });
}

process.env.PAPERCLIP_HOME = homeDir;
process.env.PAPERCLIP_INSTANCE_ID = instanceId;
process.env.PAPERCLIP_CONFIG = configPath;
process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = masterKeyPath;
process.env.PAPERCLIP_DB_BACKUP_ENABLED = "false";

let db: DisposableDatabase | undefined;
let shutdownServer: ((signal?: "SIGINT" | "SIGTERM") => Promise<void>) | undefined;
let shuttingDown = false;
let uiBuild: { child: ChildProcess; done: Promise<void> } | null = null;

function stopUiBuild() {
  if (!uiBuild || uiBuild.child.exitCode !== null || uiBuild.child.signalCode !== null) return;
  try {
    uiBuild.child.kill("SIGTERM");
  } catch {
  }
}

function hasWarmEmbeddedPostgresTemplate(): boolean {
  if (process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE === "0") return false;
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  const templateDir = path.join(
    os.tmpdir(),
    `paperclip-embedded-postgres-templates-${uid}`,
    computeEmbeddedPostgresTemplateKey(),
  );
  return (
    fs.existsSync(path.join(templateDir, "PG_VERSION")) &&
    !fs.existsSync(path.join(templateDir, "postmaster.pid"))
  );
}

async function tuneDisposableCluster(connectionString: string): Promise<void> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  const admin = createDb(adminUrl.toString(), { maxConnections: 1 });
  try {
    await admin.$client.unsafe("ALTER SYSTEM SET fsync = off");
    await admin.$client.unsafe("ALTER SYSTEM SET synchronous_commit = off");
    await admin.$client.unsafe("ALTER SYSTEM SET full_page_writes = off");
    await admin.$client.unsafe("ALTER SYSTEM SET autovacuum = off");
    await admin.$client.unsafe("SELECT pg_reload_conf()");
  } finally {
    await admin.$client.end({ timeout: 1 });
  }
}

const usesExternalPostgres = Boolean(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim());
const useWarmTemplate = !usesExternalPostgres && hasWarmEmbeddedPostgresTemplate();

if (usesExternalPostgres) {
  const shutdownExternal = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopUiBuild();
    try {
      await shutdownServer?.(signal);
    } finally {
      await db?.cleanup();
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdownExternal("SIGINT"));
  process.once("SIGTERM", () => void shutdownExternal("SIGTERM"));
} else {
  beforeTestPostgresShutdown({
    stop: async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopUiBuild();
      await shutdownServer?.(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      if (db) await closeRegisteredClients(db.connectionString).catch(() => {});
    },
    interrupt() {},
    afterStop: async () => {
      await db?.cleanup();
    },
  });
}

let dbPromise: Promise<DisposableDatabase> | undefined;

try {
  uiBuild = startParallelUiBuild();
  const uiReady = uiBuild?.done ?? Promise.resolve();
  let startedDb: DisposableDatabase;
  let serverModule: typeof import("../../server/src/index.js");

  if (usesExternalPostgres) {
    dbPromise = startEmbeddedPostgresTestDatabase("paperclip-e2e-pg-");
    [startedDb, serverModule] = await Promise.all([
      dbPromise,
      import("../../server/src/index.js"),
      uiReady,
    ]).then(([pg, mod]) => [pg, mod] as const);
  } else if (useWarmTemplate) {
    dbPromise = (async () => {
      const pg = await startEmbeddedPostgresTestDatabase("paperclip-e2e-pg-");
      await tuneDisposableCluster(pg.connectionString);
      return pg;
    })();
    [startedDb, serverModule] = await Promise.all([
      dbPromise,
      import("../../server/src/index.js"),
      uiReady,
    ]).then(([pg, mod]) => [pg, mod] as const);
  } else {
    // Load `embedded-postgres` and spawn `initdb` BEFORE calling
    // `import("../../server/src/index.js")` so synchronous `createRequire`
    const embeddedPostgresCtor = await loadEmbeddedPostgresCtor();
    const fastPg = await startFastDisposablePostgres(embeddedPostgresCtor);
    dbPromise = fastPg.ready;
    [startedDb, serverModule] = await Promise.all([
      dbPromise,
      import("../../server/src/index.js"),
      uiReady,
    ]).then(([pg, mod]) => [pg, mod] as const);
  }
  db = startedDb;

  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      mode: "postgres",
      connectionString: db.connectionString,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 7,
        dir: path.join(instanceRoot, "data", "backups"),
      },
    },
    logging: { mode: "file", logDir: logsDir },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: { provider: "local_disk", localDisk: { baseDir: storageDir } },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: masterKeyPath },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  process.env.DATABASE_URL = db.connectionString;

  const started = await serverModule.startServer();
  shutdownServer = started.shutdown;
} catch (error) {
  stopUiBuild();
  const cleanupDb = db ?? (await dbPromise?.catch(() => undefined));
  await cleanupDb?.cleanup();
  throw error;
}
