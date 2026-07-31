import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  createEmbeddedPostgresLogBuffer,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  prepareEmbeddedPostgresNativeRuntime,
  runDatabaseRestore,
  runDatabaseTableCounts,
  type RunDatabaseTableCountsResult,
} from "@paperclipai/db";
import type { PaperclipConfig } from "../config/schema.js";
import { expandHomePrefix } from "../config/home.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";

type DatabaseTargetOptions = {
  config?: string;
  dataDir?: string;
};

type DbRestoreOptions = DatabaseTargetOptions & {
  backupFile: string;
  expectedSha256?: string;
  allowExternalTarget?: boolean;
  yes?: boolean;
  json?: boolean;
};

type DbTableCountsOptions = DatabaseTargetOptions & {
  json?: boolean;
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

type OpenDatabaseTarget = {
  connectionString: string;
  source: string;
  stop: () => Promise<void>;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!fs.existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(fs.readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function readPidFilePort(postmasterPidFile: string): number | null {
  if (!fs.existsSync(postmasterPidFile)) return null;
  try {
    const port = Number(fs.readFileSync(postmasterPidFile, "utf8").split("\n")[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(preferredPort: number): Promise<number> {
  let port = Math.max(1, Math.trunc(preferredPort));
  while (!(await isPortAvailable(port))) port += 1;
  return port;
}

function postgresConnectionString(port: number): string {
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

async function openEmbeddedTarget(input: {
  config: PaperclipConfig;
  configPath: string;
  requireStopped: boolean;
}): Promise<OpenDatabaseTarget> {
  if (input.config.database.mode !== "embedded-postgres") {
    throw new Error("Expected an embedded PostgreSQL target.");
  }

  const databaseDir = resolveRuntimeLikePath(
    input.config.database.embeddedPostgresDataDir,
    input.configPath,
  );
  const postmasterPidFile = path.resolve(databaseDir, "postmaster.pid");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  if (runningPid) {
    if (input.requireStopped) {
      throw new Error(
        `Refusing to restore while the target embedded PostgreSQL is running (pid ${runningPid}). Stop the isolated Paperclip target and retry.`,
      );
    }
    const port = readPidFilePort(postmasterPidFile) ?? input.config.database.embeddedPostgresPort;
    return {
      connectionString: postgresConnectionString(port),
      source: `embedded-postgres@${port}`,
      stop: async () => {},
    };
  }

  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }
  await prepareEmbeddedPostgresNativeRuntime();

  const port = await findAvailablePort(input.config.database.embeddedPostgresPort);
  const logBuffer = createEmbeddedPostgresLogBuffer();
  const instance = new EmbeddedPostgres({
    databaseDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: logBuffer.append,
    onError: logBuffer.append,
  });

  if (!fs.existsSync(path.resolve(databaseDir, "PG_VERSION"))) {
    try {
      await instance.initialise();
    } catch (error) {
      throw formatEmbeddedPostgresError(error, {
        fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${databaseDir} on port ${port}`,
        recentLogs: logBuffer.getRecentLogs(),
      });
    }
  }

  try {
    await instance.start();
  } catch (error) {
    throw formatEmbeddedPostgresError(error, {
      fallbackMessage: `Failed to start embedded PostgreSQL in ${databaseDir} on port ${port}`,
      recentLogs: logBuffer.getRecentLogs(),
    });
  }

  const adminConnectionString = new URL(postgresConnectionString(port));
  adminConnectionString.pathname = "/postgres";
  await ensurePostgresDatabase(adminConnectionString.toString(), "paperclip");

  return {
    connectionString: postgresConnectionString(port),
    source: `embedded-postgres@${port}`,
    stop: async () => instance.stop(),
  };
}

async function openDatabaseTarget(input: {
  config: PaperclipConfig;
  configPath: string;
  requireStopped: boolean;
  allowExternalTarget: boolean;
}): Promise<OpenDatabaseTarget> {
  if (input.config.database.mode === "embedded-postgres") {
    return await openEmbeddedTarget(input);
  }

  if (input.requireStopped && !input.allowExternalTarget) {
    throw new Error(
      "External PostgreSQL restore targets require --allow-external-target because the CLI cannot prove that an external target is isolated and stopped.",
    );
  }
  const connectionString = nonEmpty(process.env.DATABASE_URL)
    ?? nonEmpty(input.config.database.connectionString);
  if (!connectionString) {
    throw new Error("The target config uses PostgreSQL mode but does not provide a connection string.");
  }
  return {
    connectionString,
    source: process.env.DATABASE_URL ? "DATABASE_URL" : "config.database.connectionString",
    stop: async () => {},
  };
}

function resolveConfiguredTarget(opts: DatabaseTargetOptions): {
  config: PaperclipConfig;
  configPath: string;
} {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);
  if (!config) {
    throw new Error(`Paperclip config not found at ${configPath}. Initialize the isolated target first.`);
  }
  return { config, configPath };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertDataDirIsolation(input: {
  dataDir?: string;
  config: PaperclipConfig;
  configPath: string;
}): void {
  const rawDataDir = nonEmpty(input.dataDir);
  if (!rawDataDir) return;
  const homeDir = path.resolve(expandHomePrefix(rawDataDir));
  const localPaths = [
    ["config", input.configPath],
    ["database", input.config.database.mode === "embedded-postgres"
      ? resolveRuntimeLikePath(input.config.database.embeddedPostgresDataDir, input.configPath)
      : null],
    ["database backups", resolveRuntimeLikePath(input.config.database.backup.dir, input.configPath)],
    ["logs", resolveRuntimeLikePath(input.config.logging.logDir, input.configPath)],
    ["local storage", input.config.storage.provider === "local_disk"
      ? resolveRuntimeLikePath(input.config.storage.localDisk.baseDir, input.configPath)
      : null],
    ["local secrets key", input.config.secrets.provider === "local_encrypted"
      ? resolveRuntimeLikePath(input.config.secrets.localEncrypted.keyFilePath, input.configPath)
      : null],
  ] as const;

  for (const [label, candidate] of localPaths) {
    if (candidate && !isPathInside(homeDir, candidate)) {
      throw new Error(
        `Refusing non-isolated target: ${label} path ${candidate} is outside --data-dir ${homeDir}.`,
      );
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function validateExpectedSha256(value: string | undefined): string | null {
  const expected = nonEmpty(value)?.toLowerCase() ?? null;
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error("--expected-sha256 must be exactly 64 hexadecimal characters.");
  }
  return expected;
}

export async function dbRestoreCommand(opts: DbRestoreOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip db:restore ")));

  if (!nonEmpty(opts.dataDir) && !nonEmpty(opts.config)) {
    throw new Error(
      "Restore requires an explicit isolated target via --data-dir or --config; the implicit default instance is never accepted.",
    );
  }

  const backupFile = path.resolve(opts.backupFile);
  const backupStat = fs.existsSync(backupFile) ? fs.statSync(backupFile) : null;
  if (!backupStat?.isFile()) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }
  const expectedSha256 = validateExpectedSha256(opts.expectedSha256);
  const backupSha256 = await sha256File(backupFile);
  if (expectedSha256 && backupSha256 !== expectedSha256) {
    throw new Error(
      `Backup SHA-256 mismatch: expected ${expectedSha256}, got ${backupSha256}. Target was not opened.`,
    );
  }

  const targetConfig = resolveConfiguredTarget(opts);
  assertDataDirIsolation({ ...opts, ...targetConfig });
  p.log.message(pc.dim(`Target config: ${targetConfig.configPath}`));
  p.log.message(pc.dim(`Backup file: ${backupFile}`));
  p.log.message(pc.dim(`Backup SHA-256: ${backupSha256}`));

  const confirmed = opts.yes
    ? true
    : await p.confirm({
      message: `Replace database objects in the explicit target ${targetConfig.configPath}?`,
      initialValue: false,
    });
  if (p.isCancel(confirmed) || !confirmed) {
    p.log.warn("Restore cancelled; target was not opened.");
    p.outro(pc.yellow("No database changes made."));
    return;
  }

  const target = await openDatabaseTarget({
    ...targetConfig,
    requireStopped: true,
    allowExternalTarget: Boolean(opts.allowExternalTarget),
  });
  const spinner = p.spinner();
  spinner.start("Restoring database into the explicit target...");
  try {
    await runDatabaseRestore({
      connectionString: target.connectionString,
      backupFile,
    });
    const tables = await runDatabaseTableCounts({ connectionString: target.connectionString });
    spinner.stop(`Restored ${tables.tables.length} table(s).`);

    if (opts.json) {
      console.log(JSON.stringify({
        backupFile,
        backupSha256,
        backupSizeBytes: backupStat.size,
        configPath: targetConfig.configPath,
        connectionSource: target.source,
        tableCount: tables.tables.length,
      }, null, 2));
    }
    p.outro(pc.green("Restore completed; the temporary embedded target database was stopped."));
  } catch (error) {
    spinner.stop(pc.red("Restore failed."));
    throw error;
  } finally {
    await target.stop();
  }
}

function printTableCounts(result: RunDatabaseTableCountsResult): void {
  for (const table of result.tables) {
    console.log(`${table.schema}.${table.table}\t${table.rowCount}`);
  }
}

export async function dbTableCountsCommand(opts: DbTableCountsOptions): Promise<void> {
  const targetConfig = resolveConfiguredTarget(opts);
  const target = await openDatabaseTarget({
    ...targetConfig,
    requireStopped: false,
    allowExternalTarget: true,
  });
  try {
    const result = await runDatabaseTableCounts({ connectionString: target.connectionString });
    if (opts.json) {
      console.log(JSON.stringify({
        configPath: targetConfig.configPath,
        connectionSource: target.source,
        tables: result.tables,
      }, null, 2));
    } else {
      printTableCounts(result);
    }
  } finally {
    await target.stop();
  }
}
