import fs from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
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
  createDb,
  companySecretVersions,
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
  authorityManifest?: string;
  expectedManifestSha256?: string;
  countLedger?: string;
  recoveryConfig?: string;
  recoveryMasterKey?: string;
  safetyMarginBytes?: string;
  allowExternalTarget?: boolean;
  yes?: boolean;
  json?: boolean;
};

type DbTableCountsOptions = DatabaseTargetOptions & {
  ledgerFile?: string;
  json?: boolean;
};

type TableCountLedger = {
  format: "paperclip-table-count-ledger-v1";
  databaseSizeBytes: number;
  tables: RunDatabaseTableCountsResult["tables"];
};

type RestoreAuthorityManifest = {
  format: "paperclip-restore-authority-v2";
  backup: { file: string; sha256: string; sizeBytes: number };
  ledger: { file: string; sha256: string };
  restoreFootprintBytes: number;
  recovery: {
    config: { file: string; sha256: string; sizeBytes: number };
    masterKey: { file: string; sha256: string; sizeBytes: number; requiredMode: "0600" };
  };
};

const DEFAULT_RESTORE_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

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

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function isSafeByteCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseTableCountLedger(filePath: string): TableCountLedger {
  const value = readJsonObject(filePath, "table-count ledger");
  if (value.format !== "paperclip-table-count-ledger-v1" || !isSafeByteCount(value.databaseSizeBytes)) {
    throw new Error(`Invalid table-count ledger at ${filePath}: unsupported format or databaseSizeBytes.`);
  }
  if (!Array.isArray(value.tables)) {
    throw new Error(`Invalid table-count ledger at ${filePath}: tables must be an array.`);
  }
  const tables = value.tables.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Invalid table-count ledger at ${filePath}: tables[${index}] is not an object.`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.schema !== "string" || typeof row.table !== "string" || !isSafeByteCount(row.rowCount)) {
      throw new Error(`Invalid table-count ledger at ${filePath}: tables[${index}] has invalid fields.`);
    }
    return { schema: row.schema, table: row.table, rowCount: row.rowCount };
  });
  const sorted = [...tables].sort((left, right) =>
    left.schema.localeCompare(right.schema) || left.table.localeCompare(right.table));
  if (JSON.stringify(tables) !== JSON.stringify(sorted)) {
    throw new Error(`Invalid table-count ledger at ${filePath}: tables are not deterministically sorted.`);
  }
  return {
    format: "paperclip-table-count-ledger-v1",
    databaseSizeBytes: value.databaseSizeBytes,
    tables,
  };
}

function parseRestoreAuthorityManifest(filePath: string): RestoreAuthorityManifest {
  const value = readJsonObject(filePath, "restore-authority manifest");
  const backup = value.backup;
  const ledger = value.ledger;
  if (
    value.format !== "paperclip-restore-authority-v2"
    || !backup || typeof backup !== "object" || Array.isArray(backup)
    || !ledger || typeof ledger !== "object" || Array.isArray(ledger)
    || !isSafeByteCount(value.restoreFootprintBytes)
  ) {
    throw new Error(`Invalid restore-authority manifest at ${filePath}.`);
  }
  const backupValue = backup as Record<string, unknown>;
  const ledgerValue = ledger as Record<string, unknown>;
  const recovery = value.recovery;
  const recoveryValue = recovery && typeof recovery === "object" && !Array.isArray(recovery)
    ? recovery as Record<string, unknown>
    : null;
  const recoveryConfig = recoveryValue?.config;
  const recoveryMasterKey = recoveryValue?.masterKey;
  const recoveryConfigValue = recoveryConfig && typeof recoveryConfig === "object" && !Array.isArray(recoveryConfig)
    ? recoveryConfig as Record<string, unknown>
    : null;
  const recoveryMasterKeyValue = recoveryMasterKey && typeof recoveryMasterKey === "object" && !Array.isArray(recoveryMasterKey)
    ? recoveryMasterKey as Record<string, unknown>
    : null;
  if (
    typeof backupValue.file !== "string"
    || typeof backupValue.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(backupValue.sha256)
    || !isSafeByteCount(backupValue.sizeBytes)
    || typeof ledgerValue.file !== "string"
    || typeof ledgerValue.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(ledgerValue.sha256)
    || typeof recoveryConfigValue?.file !== "string"
    || typeof recoveryConfigValue.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(recoveryConfigValue.sha256)
    || !isSafeByteCount(recoveryConfigValue.sizeBytes)
    || typeof recoveryMasterKeyValue?.file !== "string"
    || typeof recoveryMasterKeyValue.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(recoveryMasterKeyValue.sha256)
    || !isSafeByteCount(recoveryMasterKeyValue.sizeBytes)
    || recoveryMasterKeyValue.requiredMode !== "0600"
  ) {
    throw new Error(`Invalid restore-authority manifest at ${filePath}: invalid backup or ledger binding.`);
  }
  return {
    format: "paperclip-restore-authority-v2",
    backup: {
      file: backupValue.file,
      sha256: backupValue.sha256,
      sizeBytes: backupValue.sizeBytes,
    },
    ledger: { file: ledgerValue.file, sha256: ledgerValue.sha256 },
    restoreFootprintBytes: value.restoreFootprintBytes,
    recovery: {
      config: recoveryConfigValue as RestoreAuthorityManifest["recovery"]["config"],
      masterKey: recoveryMasterKeyValue as RestoreAuthorityManifest["recovery"]["masterKey"],
    },
  };
}

function parseSafetyMarginBytes(raw: string | undefined): number {
  const value = raw === undefined ? DEFAULT_RESTORE_SAFETY_MARGIN_BYTES : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--safety-margin-bytes must be a positive safe integer.");
  }
  return value;
}

function nearestExistingPath(candidate: string): string {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing filesystem ancestor for ${candidate}.`);
    current = parent;
  }
  return current;
}

export function assertRestoreCapacity(input: {
  databaseDir: string;
  restoreFootprintBytes: number;
  safetyMarginBytes: number;
  availableBytes?: number;
}): { filesystemPath: string; availableBytes: number; requiredBytes: number } {
  const filesystemPath = nearestExistingPath(input.databaseDir);
  const stat = input.availableBytes === undefined
    ? fs.statfsSync(filesystemPath, { bigint: true })
    : null;
  const availableBytes = input.availableBytes
    ?? Number((stat?.bavail ?? 0n) * (stat?.bsize ?? 0n));
  const requiredBytes = input.restoreFootprintBytes + input.safetyMarginBytes;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient restore capacity on filesystem containing ${filesystemPath}: `
      + `${availableBytes} bytes available; require ${input.restoreFootprintBytes} restore bytes `
      + `plus ${input.safetyMarginBytes} safety-margin bytes (${requiredBytes} total). Target was not initialized.`,
    );
  }
  return { filesystemPath, availableBytes, requiredBytes };
}

export async function validateRestoreAuthority(input: {
  backupFile: string;
  backupStat: fs.Stats;
  authorityManifest: string;
  expectedManifestSha256: string;
  countLedger: string;
  recoveryConfig: string;
  recoveryMasterKey: string;
}): Promise<{ manifest: RestoreAuthorityManifest; ledger: TableCountLedger; manifestSha256: string }> {
  const manifestSha256 = await sha256File(input.authorityManifest);
  if (manifestSha256 !== input.expectedManifestSha256) {
    throw new Error(
      `Restore-authority manifest SHA-256 mismatch: expected ${input.expectedManifestSha256}, got ${manifestSha256}. Target was not opened.`,
    );
  }
  const manifest = parseRestoreAuthorityManifest(input.authorityManifest);
  const ledger = parseTableCountLedger(input.countLedger);
  if (path.basename(input.backupFile) !== manifest.backup.file || input.backupStat.size !== manifest.backup.sizeBytes) {
    throw new Error("Backup file name or size does not match the restore-authority manifest. Target was not opened.");
  }
  if (path.basename(input.countLedger) !== manifest.ledger.file) {
    throw new Error("Table-count ledger name does not match the restore-authority manifest. Target was not opened.");
  }
  const recoveryConfigStat = fs.statSync(input.recoveryConfig);
  const recoveryMasterKeyStat = fs.statSync(input.recoveryMasterKey);
  const [backupSha256, ledgerSha256, recoveryConfigSha256, recoveryMasterKeySha256] = await Promise.all([
    sha256File(input.backupFile),
    sha256File(input.countLedger),
    sha256File(input.recoveryConfig),
    sha256File(input.recoveryMasterKey),
  ]);
  if (backupSha256 !== manifest.backup.sha256) {
    throw new Error(`Backup SHA-256 does not match the restore-authority manifest. Target was not opened.`);
  }
  if (ledgerSha256 !== manifest.ledger.sha256) {
    throw new Error(`Table-count ledger SHA-256 does not match the restore-authority manifest. Target was not opened.`);
  }
  if (
    path.basename(input.recoveryConfig) !== manifest.recovery.config.file
    || recoveryConfigStat.size !== manifest.recovery.config.sizeBytes
    || recoveryConfigSha256 !== manifest.recovery.config.sha256
  ) {
    throw new Error("Recovery config does not match the restore-authority manifest. Target was not opened.");
  }
  if (
    path.basename(input.recoveryMasterKey) !== manifest.recovery.masterKey.file
    || recoveryMasterKeyStat.size !== manifest.recovery.masterKey.sizeBytes
    || recoveryMasterKeySha256 !== manifest.recovery.masterKey.sha256
  ) {
    throw new Error("Recovery master key does not match the restore-authority manifest. Target was not opened.");
  }
  if (ledger.databaseSizeBytes !== manifest.restoreFootprintBytes) {
    throw new Error("Restore footprint does not match the manifest-bound table-count ledger. Target was not opened.");
  }
  return { manifest, ledger, manifestSha256 };
}

function decodeRecoveryMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const decoded = /^[A-Fa-f0-9]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (decoded.length !== 32) throw new Error("Recovery master key is not valid 32-byte key material.");
  return decoded;
}

export function assertSecretDecryptionReadiness(materials: Record<string, unknown>[], rawKey: string): number {
  const key = decodeRecoveryMasterKey(rawKey);
  let checked = 0;
  for (const material of materials) {
    if (material.scheme !== "local_encrypted_v1") continue;
    if (typeof material.iv !== "string" || typeof material.tag !== "string" || typeof material.ciphertext !== "string") {
      throw new Error("Secret-decryption readiness failed: invalid encrypted material.");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(material.iv, "base64"));
      decipher.setAuthTag(Buffer.from(material.tag, "base64"));
      decipher.update(Buffer.from(material.ciphertext, "base64"));
      decipher.final();
      checked += 1;
    } catch {
      throw new Error("Secret-decryption readiness failed: recovery master key does not match restored encrypted records.");
    }
  }
  return checked;
}

function installRecoveryArtifacts(input: {
  config: PaperclipConfig;
  configPath: string;
  recoveryConfig: string;
  recoveryMasterKey: string;
}): { targetKeyPath: string; retainedConfigPath: string } {
  if (input.config.secrets.provider !== "local_encrypted") {
    throw new Error("Supported recovery currently requires the local_encrypted secrets provider.");
  }
  const targetKeyPath = resolveRuntimeLikePath(input.config.secrets.localEncrypted.keyFilePath, input.configPath);
  const recoveryDir = path.resolve(path.dirname(input.configPath), "recovery");
  const retainedConfigPath = path.resolve(recoveryDir, "backup-time-config.json");
  fs.mkdirSync(path.dirname(targetKeyPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(input.recoveryMasterKey, `${targetKeyPath}.partial`);
  fs.chmodSync(`${targetKeyPath}.partial`, 0o600);
  fs.renameSync(`${targetKeyPath}.partial`, targetKeyPath);
  fs.copyFileSync(input.recoveryConfig, `${retainedConfigPath}.partial`);
  fs.chmodSync(`${retainedConfigPath}.partial`, 0o600);
  fs.renameSync(`${retainedConfigPath}.partial`, retainedConfigPath);
  return { targetKeyPath, retainedConfigPath };
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
  const authorityManifest = nonEmpty(opts.authorityManifest);
  const expectedManifestSha256 = validateExpectedSha256(opts.expectedManifestSha256);
  const countLedger = nonEmpty(opts.countLedger);
  const recoveryConfig = nonEmpty(opts.recoveryConfig);
  const recoveryMasterKey = nonEmpty(opts.recoveryMasterKey);
  if (!authorityManifest || !expectedManifestSha256 || !countLedger || !recoveryConfig || !recoveryMasterKey) {
    throw new Error(
      "Restore requires manifest-bound database, ledger, recovery config, and recovery master-key artifacts.",
    );
  }
  const resolvedAuthorityManifest = path.resolve(authorityManifest);
  const resolvedCountLedger = path.resolve(countLedger);
  const resolvedRecoveryConfig = path.resolve(recoveryConfig);
  const resolvedRecoveryMasterKey = path.resolve(recoveryMasterKey);
  for (const [label, candidate] of [
    ["Restore-authority manifest", resolvedAuthorityManifest],
    ["Table-count ledger", resolvedCountLedger],
    ["Recovery config", resolvedRecoveryConfig],
    ["Recovery master key", resolvedRecoveryMasterKey],
  ] as const) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`${label} file not found: ${candidate}`);
    }
  }
  const authority = await validateRestoreAuthority({
    backupFile,
    backupStat,
    authorityManifest: resolvedAuthorityManifest,
    expectedManifestSha256,
    countLedger: resolvedCountLedger,
    recoveryConfig: resolvedRecoveryConfig,
    recoveryMasterKey: resolvedRecoveryMasterKey,
  });
  const expectedSha256 = validateExpectedSha256(opts.expectedSha256);
  const backupSha256 = authority.manifest.backup.sha256;
  if (expectedSha256 && backupSha256 !== expectedSha256) {
    throw new Error(
      `Backup SHA-256 mismatch: expected ${expectedSha256}, got ${backupSha256}. Target was not opened.`,
    );
  }

  const targetConfig = resolveConfiguredTarget(opts);
  assertDataDirIsolation({ ...opts, ...targetConfig });
  if (targetConfig.config.database.mode !== "embedded-postgres") {
    throw new Error(
      "Fail-closed restore capacity validation currently requires an embedded PostgreSQL target on a locally validated filesystem.",
    );
  }
  const databaseDir = resolveRuntimeLikePath(
    targetConfig.config.database.embeddedPostgresDataDir,
    targetConfig.configPath,
  );
  const safetyMarginBytes = parseSafetyMarginBytes(opts.safetyMarginBytes);
  const capacity = assertRestoreCapacity({
    databaseDir,
    restoreFootprintBytes: authority.manifest.restoreFootprintBytes,
    safetyMarginBytes,
  });
  p.log.message(pc.dim(`Target config: ${targetConfig.configPath}`));
  p.log.message(pc.dim(`Backup file: ${backupFile}`));
  p.log.message(pc.dim(`Backup SHA-256: ${backupSha256}`));
  p.log.message(pc.dim(`Restore-authority manifest SHA-256: ${authority.manifestSha256}`));
  p.log.message(pc.dim(
    `Capacity: ${capacity.availableBytes} bytes available; ${capacity.requiredBytes} required on ${capacity.filesystemPath}`,
  ));

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

  const installedRecovery = installRecoveryArtifacts({
    ...targetConfig,
    recoveryConfig: resolvedRecoveryConfig,
    recoveryMasterKey: resolvedRecoveryMasterKey,
  });

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
    if (JSON.stringify(tables.tables) !== JSON.stringify(authority.ledger.tables)) {
      throw new Error(
        "Restored table names/counts do not match the manifest-bound backup-time ledger.",
      );
    }
    const readinessDb = createDb(target.connectionString);
    const secretMaterials = await readinessDb.select({ material: companySecretVersions.material }).from(companySecretVersions);
    const secretsChecked = assertSecretDecryptionReadiness(
      secretMaterials.map((row) => row.material),
      fs.readFileSync(installedRecovery.targetKeyPath, "utf8"),
    );
    spinner.stop(`Restored ${tables.tables.length} table(s).`);

    if (opts.json) {
      console.log(JSON.stringify({
        backupFile,
        backupSha256,
        backupSizeBytes: backupStat.size,
        authorityManifest: resolvedAuthorityManifest,
        authorityManifestSha256: authority.manifestSha256,
        countLedger: resolvedCountLedger,
        restoreFootprintBytes: authority.manifest.restoreFootprintBytes,
        safetyMarginBytes,
        capacityAvailableBytes: capacity.availableBytes,
        capacityRequiredBytes: capacity.requiredBytes,
        configPath: targetConfig.configPath,
        connectionSource: target.source,
        tableCount: tables.tables.length,
        secretsChecked,
        secretDecryptionReady: true,
        recoveryModeRequired: true,
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
    if (opts.ledgerFile) {
      const ledgerFile = path.resolve(opts.ledgerFile);
      const partial = `${ledgerFile}.partial`;
      const ledger: TableCountLedger = {
        format: "paperclip-table-count-ledger-v1",
        databaseSizeBytes: result.databaseSizeBytes,
        tables: result.tables,
      };
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      fs.writeFileSync(partial, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o640 });
      fs.renameSync(partial, ledgerFile);
    }
    if (opts.json) {
      console.log(JSON.stringify({
        configPath: targetConfig.configPath,
        connectionSource: target.source,
        databaseSizeBytes: result.databaseSizeBytes,
        tables: result.tables,
      }, null, 2));
    } else {
      printTableCounts(result);
    }
  } finally {
    await target.stop();
  }
}
