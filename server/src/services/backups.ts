import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { restoreDatabaseBackup, runDatabaseBackup } from "@paperclipai/db";
import {
  backupAuditEventSchema,
  backupAuditSummarySchema,
  backupBundleIntegritySchema,
  backupHistoryActionResultSchema,
  backupRollbackStateSchema,
  backupRestoreStateSchema,
  backupRestorePreviewSchema,
  backupOverviewSchema,
  backupRunSchema,
  backupSettingsSchema,
  backupSignatureSchema,
  type BackupBundleIntegrity,
  type BackupAuditEvent,
  type BackupRestoreState,
  type BackupComponentKey,
  type BackupComponentIntegrity,
  type BackupIntegrityStatus,
  type BackupHistoryActionResult,
  type BackupComponentResult,
  type BackupComponentSupport,
  type BackupOverview,
  type BackupRestorePreview,
  type BackupRestorePreviewComponent,
  type BackupRun,
  type BackupRollbackState,
  type BackupSignatureStatus,
  type BackupSettings,
  type BackupTriggerSource,
  type BackupRemoteCopy,
  type UpdateBackupSettings,
} from "@paperclipai/shared";
import type { Config } from "../config.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "../paths.js";
import {
  resolveDefaultSecretsKeyFilePath,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { inspectImportedArchive } from "./backup-archive.js";

type SnapshotTarget = {
  key: Exclude<BackupComponentKey, "database">;
  label: string;
  selected: boolean;
  sourcePath: string | null;
  destinationName: string;
  notes?: string;
  supported?: boolean;
};

type PathStats = {
  sizeBytes: number;
  itemCount: number;
};

type BackupDownloadDescriptor = {
  backup: BackupRun;
  bundleName: string;
  bundlePath: string;
  bundleDirectory: string;
  archiveName: string;
};

type RestorePathKind = "file" | "directory";
type PathDigest = {
  scope: "file" | "tree";
  hash: string;
  fileCount: number;
  totalBytes: number;
};
type BackupSignatureVerification = {
  status: BackupSignatureStatus;
  keyId: string | null;
  issues: string[];
};
type RemoteS3ClientConfig = {
  bucket: string;
  region: string;
  endpoint: string | null;
  prefix: string;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  forcePathStyle: boolean;
  serverSideEncryption: "none" | "AES256" | "aws:kms";
  kmsKeyId: string | null;
};

export type BackupManager = ReturnType<typeof createBackupManager>;

const SETTINGS_FILENAME = "backup-manager.json";
const RESTORE_STATE_FILENAME = "backup-restore-state.json";
const AUDIT_LOG_FILENAME = "backup-audit.jsonl";
const MANIFEST_FILENAME = "manifest.json";
const BACKUP_ARCHIVE_DIRNAME = "_archive";
const BACKUP_CHECKPOINT_DIRNAME = "_restore-checkpoints";
const DEFAULT_COMPONENTS = {
  storage: true,
  config: true,
  env: false,
  secretsKey: false,
  workspaces: false,
} as const;
const RESTORE_COMPONENT_ORDER: BackupComponentKey[] = [
  "database",
  "storage",
  "config",
  "env",
  "secretsKey",
  "workspaces",
];
const RESTORE_COMPONENT_LABELS: Record<BackupComponentKey, string> = {
  database: "Database",
  storage: "Storage assets",
  config: "Instance config",
  env: "Instance env file",
  secretsKey: "Secrets master key",
  workspaces: "Agent workspaces",
};

function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

function bundleTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function normalizeS3Prefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildS3ObjectKey(prefix: string, objectKey: string): string {
  const normalized = normalizeS3Prefix(prefix);
  return normalized ? `${normalized}/${objectKey}` : objectKey;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function joinNotes(...parts: Array<string | null | undefined>): string | null {
  const notes = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return notes.length > 0 ? notes.join("; ") : null;
}

function getRetentionReferenceTime(backup: BackupRun): string {
  return backup.importedAt ?? backup.finishedAt ?? backup.startedAt;
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function createS3Client(config: RemoteS3ClientConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle,
    credentials:
      config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined,
  });
}

async function createTarArchive(opts: {
  bundleDirectory: string;
  bundleName: string;
  archivePath: string;
}): Promise<{ archivePath: string; sizeBytes: number }> {
  await mkdir(path.dirname(opts.archivePath), { recursive: true });
  await runCommand("tar", ["-czf", opts.archivePath, "-C", opts.bundleDirectory, opts.bundleName]);
  const archiveStats = await stat(opts.archivePath);
  return {
    archivePath: opts.archivePath,
    sizeBytes: archiveStats.size,
  };
}

function buildSignaturePayload(run: BackupRun): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    triggerSource: run.triggerSource,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    bundleName: run.bundleName,
    error: run.error,
    containsSensitiveData: run.containsSensitiveData,
    integrity: run.integrity,
    components: run.components.map((component) => ({
      key: component.key,
      label: component.label,
      status: component.status,
      relativePath: component.relativePath,
      sizeBytes: component.sizeBytes,
      itemCount: component.itemCount,
      notes: component.notes,
    })),
  };
}

function signBackupRun(opts: {
  run: BackupRun;
  secret: string;
  keyId: string | null;
}) {
  const payload = stableJson(buildSignaturePayload(opts.run));
  return backupSignatureSchema.parse({
    algorithm: "hmac-sha256",
    keyId: opts.keyId,
    signedAt: nowIso(),
    signature: createHmac("sha256", opts.secret).update(payload).digest("hex"),
  });
}

function verifyBackupSignature(opts: {
  run: BackupRun;
  secret: string | undefined;
}): BackupSignatureVerification {
  if (!opts.run.signature) {
    return {
      status: "missing",
      keyId: null,
      issues: ["This snapshot does not have a recorded manifest signature."],
    };
  }
  if (!opts.secret) {
    return {
      status: "unverifiable",
      keyId: opts.run.signature.keyId,
      issues: ["A backup signing secret is not configured on this instance, so the signature cannot be verified."],
    };
  }

  try {
    const expected = signBackupRun({
      run: {
        ...opts.run,
        signature: null,
      },
      secret: opts.secret,
      keyId: opts.run.signature.keyId,
    });
    const expectedBytes = Buffer.from(expected.signature, "hex");
    const actualBytes = Buffer.from(opts.run.signature.signature, "hex");
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      return {
        status: "mismatch",
        keyId: opts.run.signature.keyId,
        issues: ["Manifest signature does not match the current bundle metadata."],
      };
    }
    return {
      status: "verified",
      keyId: opts.run.signature.keyId,
      issues: [],
    };
  } catch (error) {
    return {
      status: "error",
      keyId: opts.run.signature.keyId,
      issues: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function assertNoSymlinks(rootPath: string): Promise<void> {
  const rootStat = await lstat(rootPath);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Backup bundle root may not be a symbolic link.");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("Backup bundle root must be a directory.");
  }

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.resolve(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Backup archive contains a symbolic link: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(childPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Backup archive contains an unsupported entry: ${entry.name}`);
    }
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

async function listFilesRecursively(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const childPath = path.resolve(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(childPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(childPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function computePathDigest(targetPath: string): Promise<PathDigest> {
  const targetStat = await stat(targetPath);
  if (targetStat.isFile()) {
    return {
      scope: "file",
      hash: await computeFileSha256(targetPath),
      fileCount: 1,
      totalBytes: targetStat.size,
    };
  }

  if (!targetStat.isDirectory()) {
    throw new Error(`Cannot compute integrity for unsupported path '${targetPath}'.`);
  }

  const files = await listFilesRecursively(targetPath);
  const treeHash = createHash("sha256");
  let totalBytes = 0;
  for (const filePath of files) {
    const fileStat = await stat(filePath);
    const fileHash = await computeFileSha256(filePath);
    totalBytes += fileStat.size;
    treeHash.update(path.relative(targetPath, filePath));
    treeHash.update("\0");
    treeHash.update(String(fileStat.size));
    treeHash.update("\0");
    treeHash.update(fileHash);
    treeHash.update("\n");
  }

  return {
    scope: "tree",
    hash: treeHash.digest("hex"),
    fileCount: files.length,
    totalBytes,
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tmpPath, filePath);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectPathStats(targetPath: string): Promise<PathStats> {
  const targetStat = await stat(targetPath);
  if (!targetStat.isDirectory()) {
    return { sizeBytes: targetStat.size, itemCount: 1 };
  }

  let sizeBytes = 0;
  let itemCount = 0;
  const entries = await readdir(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = path.resolve(targetPath, entry.name);
    if (entry.isDirectory()) {
      const childStats = await collectPathStats(childPath);
      sizeBytes += childStats.sizeBytes;
      itemCount += childStats.itemCount;
      continue;
    }
    if (!entry.isFile()) continue;
    const childStat = await stat(childPath);
    sizeBytes += childStat.size;
    itemCount += 1;
  }

  return { sizeBytes, itemCount };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function createBackupManager(opts: {
  connectionString: string;
  config: Config;
}) {
  const instanceRoot = resolvePaperclipInstanceRoot();
  const settingsPath = path.resolve(instanceRoot, SETTINGS_FILENAME);
  const restoreStatePath = path.resolve(instanceRoot, RESTORE_STATE_FILENAME);
  const auditLogPath = path.resolve(instanceRoot, "logs", AUDIT_LOG_FILENAME);
  let schedulerAnchorAt = new Date();
  let activeRunId: string | null = null;
  let activeRunStartedAt: string | null = null;
  let activeRunPromise: Promise<BackupRun> | null = null;
  let lastAutomaticRunAt: string | null = null;
  let activeRestorePromise: Promise<BackupRestoreState> | null = null;
  let snapshotBarrierActive = false;

  function getDefaultSettings(): BackupSettings {
    return backupSettingsSchema.parse({
      enabled: opts.config.databaseBackupEnabled,
      intervalMinutes: opts.config.databaseBackupIntervalMinutes,
      retentionDays: opts.config.databaseBackupRetentionDays,
      directory: opts.config.databaseBackupDir,
      components: DEFAULT_COMPONENTS,
      requireSignedBackups: opts.config.backupRequireSignedBackupsDefault,
      remote: {
        provider: opts.config.backupRemoteProviderDefault,
        s3: {
          bucket: opts.config.backupRemoteS3BucketDefault,
          region: opts.config.backupRemoteS3RegionDefault,
          endpoint: opts.config.backupRemoteS3EndpointDefault ?? null,
          prefix: opts.config.backupRemoteS3PrefixDefault,
          accessKeyId: opts.config.backupRemoteS3AccessKeyIdDefault ?? null,
          secretAccessKey: opts.config.backupRemoteS3SecretAccessKeyDefault ?? null,
          forcePathStyle: opts.config.backupRemoteS3ForcePathStyleDefault,
          deleteFromRemoteOnDelete: opts.config.backupRemoteS3DeleteOnDeleteDefault,
          serverSideEncryption: opts.config.backupRemoteS3ServerSideEncryptionDefault,
          kmsKeyId: opts.config.backupRemoteS3KmsKeyIdDefault ?? null,
        },
      },
      updatedAt: null,
      updatedBy: null,
    });
  }

  function getIdleRestoreState(): BackupRestoreState {
    return backupRestoreStateSchema.parse({
      status: "idle",
      sourceBackupId: null,
      sourceBundleName: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      notes: null,
      restoredComponents: [],
    });
  }

  async function readSettings(): Promise<BackupSettings> {
    const defaults = getDefaultSettings();
    const raw = await readJsonFile<Partial<BackupSettings>>(settingsPath);
    if (!raw) return defaults;

    const merged = {
      ...defaults,
      ...raw,
      components: {
        ...defaults.components,
        ...(raw.components ?? {}),
      },
    };

    const parsed = backupSettingsSchema.safeParse(merged);
    if (parsed.success) return parsed.data;

    logger.warn({ issues: parsed.error.issues }, "Invalid backup manager settings file; using defaults");
    return defaults;
  }

  async function writeSettings(settings: BackupSettings): Promise<BackupSettings> {
    const parsed = backupSettingsSchema.parse(settings);
    await writeJsonAtomic(settingsPath, parsed);
    return parsed;
  }

  async function readRestoreState(): Promise<BackupRestoreState> {
    const raw = await readJsonFile<unknown>(restoreStatePath);
    if (!raw) return getIdleRestoreState();

    const parsed = backupRestoreStateSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "Invalid backup restore state file; resetting state");
      return getIdleRestoreState();
    }

    let state = parsed.data;
    if (state.status === "running" && !activeRestorePromise) {
      state = backupRestoreStateSchema.parse({
        ...state,
        status: "failed",
        finishedAt: nowIso(),
        error: state.error ?? "Restore was interrupted before completion.",
        notes: joinNotes(state.notes, "The server exited or restarted before the restore completed."),
      });
      await writeJsonAtomic(restoreStatePath, state);
    }

    return state;
  }

  async function writeRestoreState(state: BackupRestoreState): Promise<BackupRestoreState> {
    const parsed = backupRestoreStateSchema.parse(state);
    await writeJsonAtomic(restoreStatePath, parsed);
    return parsed;
  }

  async function readRecentAuditEvents(limit: number = 25): Promise<BackupAuditEvent[]> {
    if (!(await pathExists(auditLogPath))) return [];
    const raw = await readFile(auditLogPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const recent = lines.slice(Math.max(0, lines.length - Math.max(1, limit)));
    const events: BackupAuditEvent[] = [];
    for (const line of recent) {
      try {
        const parsed = backupAuditEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          events.push(parsed.data);
        }
      } catch {
        continue;
      }
    }
    return events;
  }

  async function readLastAuditHash(): Promise<string | null> {
    const recent = await readRecentAuditEvents(1);
    return recent[0]?.hash ?? null;
  }

  async function appendAuditEvent(input: {
    action: string;
    result: "started" | "succeeded" | "failed" | "blocked" | "info";
    actorId?: string | null;
    backupId?: string | null;
    bundleName?: string | null;
    details?: Record<string, unknown> | null;
  }): Promise<BackupAuditEvent> {
    const previousHash = await readLastAuditHash();
    const draft = {
      id: randomUUID(),
      createdAt: nowIso(),
      action: input.action,
      result: input.result,
      actorId: input.actorId ?? null,
      backupId: input.backupId ?? null,
      bundleName: input.bundleName ?? null,
      details: input.details ?? null,
      previousHash,
    };
    const hash = createHash("sha256").update(stableJson(draft)).digest("hex");
    const event = backupAuditEventSchema.parse({
      ...draft,
      hash,
    });
    await mkdir(path.dirname(auditLogPath), { recursive: true });
    await writeFile(auditLogPath, JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" });
    return event;
  }

  async function ensureRestoreIdle(action: string): Promise<void> {
    const restoreState = await readRestoreState();
    if (restoreState.status === "running") {
      throw conflict(`Cannot ${action} while a restore is running.`);
    }
  }

  async function scanBackupDirectory(directory: string): Promise<BackupRun[]> {
    if (!existsSync(directory)) return [];

    const entries = await readdir(directory, { withFileTypes: true });
    const backups: BackupRun[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === BACKUP_CHECKPOINT_DIRNAME) continue;
      const bundlePath = path.resolve(directory, entry.name);
      const manifestPath = path.resolve(bundlePath, MANIFEST_FILENAME);
      const raw = await readJsonFile<unknown>(manifestPath);
      if (!raw) continue;
      const parsed = backupRunSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ bundlePath, issues: parsed.error.issues }, "Skipping invalid backup manifest");
        continue;
      }
      const run = {
        ...parsed.data,
        bundleName: entry.name,
        bundlePath,
      } satisfies BackupRun;
      if (run.status === "running" && run.id !== activeRunId) {
        backups.push({
          ...run,
          status: "failed",
          finishedAt: run.finishedAt ?? run.startedAt,
          error: run.error ?? "Backup was interrupted before completion.",
        });
        continue;
      }
      backups.push(run);
    }

    return backups;
  }

  async function listBackups(directory: string): Promise<BackupRun[]> {
    if (!existsSync(directory)) return [];

    const activeBackups = await scanBackupDirectory(directory);
    const archivedBackups = await scanBackupDirectory(path.resolve(directory, BACKUP_ARCHIVE_DIRNAME));
    return [...activeBackups, ...archivedBackups].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  function getSupport(): BackupComponentSupport[] {
    return [
      {
        key: "database",
        label: "Database",
        supported: true,
        recommended: true,
        reason: null,
      },
      {
        key: "storage",
        label: "Storage assets",
        supported: opts.config.storageProvider === "local_disk",
        recommended: true,
        reason:
          opts.config.storageProvider === "local_disk"
            ? null
            : `Remote storage provider '${opts.config.storageProvider}' is not snapshotted by the local backup manager.`,
      },
      {
        key: "config",
        label: "Instance config",
        supported: true,
        recommended: true,
        reason: null,
      },
      {
        key: "env",
        label: "Instance env file",
        supported: true,
        recommended: false,
        reason: "Sensitive. Leave disabled unless you need portable instance-level restore of environment variables.",
      },
      {
        key: "secretsKey",
        label: "Secrets master key",
        supported: opts.config.secretsProvider === "local_encrypted",
        recommended: false,
        reason:
          opts.config.secretsProvider === "local_encrypted"
            ? "Highly sensitive. Include only when cross-machine restore must decrypt existing local_encrypted secrets."
            : `Secrets provider '${opts.config.secretsProvider}' does not use a local master key file.`,
      },
      {
        key: "workspaces",
        label: "Agent workspaces",
        supported: true,
        recommended: false,
        reason: "Optional. Useful for local agent state, but can grow large quickly.",
      },
    ];
  }

  function resolveSnapshotTargets(settings: BackupSettings): SnapshotTarget[] {
    const configPath = resolvePaperclipConfigPath();
    const envPath = resolvePaperclipEnvPath();
    const managerSettingsPath = settingsPath;
    const secretsKeyPath =
      opts.config.secretsProvider === "local_encrypted"
        ? opts.config.secretsMasterKeyFilePath || resolveDefaultSecretsKeyFilePath()
        : null;
    const workspacesPath = path.resolve(instanceRoot, "workspaces");

    return [
      {
        key: "storage",
        label: "Storage assets",
        selected: settings.components.storage,
        sourcePath: opts.config.storageProvider === "local_disk" ? opts.config.storageLocalDiskBaseDir : null,
        destinationName: "storage",
        supported: opts.config.storageProvider === "local_disk",
        notes:
          opts.config.storageProvider === "local_disk"
            ? undefined
            : `Storage provider '${opts.config.storageProvider}' must be backed up outside Paperclip.`,
      },
      {
        key: "config",
        label: "Instance config",
        selected: settings.components.config,
        sourcePath: null,
        destinationName: "config",
        supported: true,
        notes: [configPath, managerSettingsPath].filter(Boolean).join("\n"),
      },
      {
        key: "env",
        label: "Instance env file",
        selected: settings.components.env,
        sourcePath: envPath,
        destinationName: "env/.env",
        supported: true,
      },
      {
        key: "secretsKey",
        label: "Secrets master key",
        selected: settings.components.secretsKey,
        sourcePath: secretsKeyPath,
        destinationName: "secrets/master.key",
        supported: opts.config.secretsProvider === "local_encrypted",
        notes:
          opts.config.secretsProvider === "local_encrypted"
            ? undefined
            : `Secrets provider '${opts.config.secretsProvider}' does not use a local key file.`,
      },
      {
        key: "workspaces",
        label: "Agent workspaces",
        selected: settings.components.workspaces,
        sourcePath: workspacesPath,
        destinationName: "workspaces",
        supported: true,
      },
    ];
  }

  async function snapshotConfig(bundleDir: string, target: SnapshotTarget): Promise<BackupComponentResult> {
    if (!target.selected) {
      return {
        key: target.key,
        label: target.label,
        status: "skipped",
        relativePath: null,
        absolutePath: null,
        sizeBytes: null,
        itemCount: null,
        notes: null,
      };
    }

    const configDir = path.resolve(bundleDir, target.destinationName);
    await mkdir(configDir, { recursive: true });

    const files = [
      { source: resolvePaperclipConfigPath(), name: "config.json" },
      { source: settingsPath, name: SETTINGS_FILENAME },
    ];

    let copied = 0;
    let sizeBytes = 0;
    const notes: string[] = [];
    for (const file of files) {
      if (!(await pathExists(file.source))) {
        notes.push(`Missing ${file.name}`);
        continue;
      }
      const destination = path.resolve(configDir, file.name);
      await cp(file.source, destination, { force: true });
      const fileStat = await stat(destination);
      sizeBytes += fileStat.size;
      copied += 1;
    }

    if (copied === 0) {
      return {
        key: target.key,
        label: target.label,
        status: "missing",
        relativePath: null,
        absolutePath: null,
        sizeBytes: 0,
        itemCount: 0,
        notes: notes.join("; ") || "No config files were found.",
      };
    }

    return {
      key: target.key,
      label: target.label,
      status: "included",
      relativePath: path.relative(bundleDir, configDir),
      absolutePath: configDir,
      sizeBytes,
      itemCount: copied,
      notes: notes.length > 0 ? notes.join("; ") : null,
    };
  }

  async function snapshotPath(bundleDir: string, target: SnapshotTarget): Promise<BackupComponentResult> {
    if (!target.selected) {
      return {
        key: target.key,
        label: target.label,
        status: "skipped",
        relativePath: null,
        absolutePath: null,
        sizeBytes: null,
        itemCount: null,
        notes: null,
      };
    }

    if (target.supported === false) {
      return {
        key: target.key,
        label: target.label,
        status: "unsupported",
        relativePath: null,
        absolutePath: null,
        sizeBytes: null,
        itemCount: null,
        notes: target.notes ?? "This component is not supported by the local backup manager.",
      };
    }

    if (!target.sourcePath || !(await pathExists(target.sourcePath))) {
      return {
        key: target.key,
        label: target.label,
        status: "missing",
        relativePath: null,
        absolutePath: null,
        sizeBytes: 0,
        itemCount: 0,
        notes: target.notes ?? "Source path does not exist.",
      };
    }

    const destinationPath = path.resolve(bundleDir, target.destinationName);
    const sourceStat = await stat(target.sourcePath);
    if (sourceStat.isDirectory() && isPathInside(target.sourcePath, bundleDir)) {
      return {
        key: target.key,
        label: target.label,
        status: "failed",
        relativePath: null,
        absolutePath: null,
        sizeBytes: 0,
        itemCount: 0,
        notes: "Backup directory is nested inside the source path, which would recurse indefinitely.",
      };
    }

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await cp(target.sourcePath, destinationPath, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });

    const stats = await collectPathStats(destinationPath);
    return {
      key: target.key,
      label: target.label,
      status: "included",
      relativePath: path.relative(bundleDir, destinationPath),
      absolutePath: destinationPath,
      sizeBytes: stats.sizeBytes,
      itemCount: stats.itemCount,
      notes: target.notes ?? null,
    };
  }

  async function writeManifest(run: BackupRun): Promise<void> {
    const manifestPath = path.resolve(run.bundlePath, MANIFEST_FILENAME);
    await writeJsonAtomic(manifestPath, run);
  }

  function containsSensitiveComponents(components: BackupComponentResult[]): boolean {
    return components.some(
      (component) =>
        component.status === "included" && (component.key === "env" || component.key === "secretsKey"),
    );
  }

  function resolveRemoteS3Config(settings: BackupSettings): RemoteS3ClientConfig | null {
    if (settings.remote.provider !== "s3") return null;
    return {
      bucket: settings.remote.s3.bucket.trim(),
      region: settings.remote.s3.region.trim(),
      endpoint: settings.remote.s3.endpoint?.trim() || null,
      prefix: settings.remote.s3.prefix,
      accessKeyId: settings.remote.s3.accessKeyId?.trim() || null,
      secretAccessKey: settings.remote.s3.secretAccessKey?.trim() || null,
      forcePathStyle: settings.remote.s3.forcePathStyle,
      serverSideEncryption: settings.remote.s3.serverSideEncryption,
      kmsKeyId: settings.remote.s3.kmsKeyId?.trim() || null,
    };
  }

  async function uploadRemoteCopies(run: BackupRun, settings: BackupSettings): Promise<BackupRemoteCopy[]> {
    const remote = resolveRemoteS3Config(settings);
    if (!remote) return [];

    const stagingRoot = await mkdtemp(path.resolve(instanceRoot, "tmp", "backup-remote-upload-"));
    const archiveName = `${run.bundleName}.tar.gz`;
    const archivePath = path.resolve(stagingRoot, archiveName);
    try {
      const archive = await createTarArchive({
        bundleDirectory: path.dirname(run.bundlePath),
        bundleName: run.bundleName,
        archivePath,
      });
      const objectKey = buildS3ObjectKey(remote.prefix, archiveName);
      const client = createS3Client(remote);
      const result = await client.send(
        new PutObjectCommand({
          Bucket: remote.bucket,
          Key: objectKey,
          Body: createReadStream(archive.archivePath),
          ContentLength: archive.sizeBytes,
          ContentType: "application/gzip",
          ServerSideEncryption:
            remote.serverSideEncryption === "none" ? undefined : remote.serverSideEncryption,
          SSEKMSKeyId: remote.serverSideEncryption === "aws:kms" ? remote.kmsKeyId ?? undefined : undefined,
        }),
      );

      return [{
        provider: "s3",
        status: "uploaded",
        bucket: remote.bucket,
        region: remote.region,
        endpoint: remote.endpoint,
        key: objectKey,
        sizeBytes: archive.sizeBytes,
        uploadedAt: nowIso(),
        etag: result.ETag ?? null,
        notes: null,
      }];
    } catch (error) {
      return [{
        provider: "s3",
        status: "failed",
        bucket: remote.bucket,
        region: remote.region,
        endpoint: remote.endpoint,
        key: buildS3ObjectKey(remote.prefix, archiveName),
        sizeBytes: null,
        uploadedAt: null,
        etag: null,
        notes: error instanceof Error ? error.message : String(error),
      }];
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async function deleteRemoteCopies(backup: BackupRun, settings: BackupSettings): Promise<void> {
    const remote = resolveRemoteS3Config(settings);
    if (!remote || settings.remote.s3.deleteFromRemoteOnDelete !== true) return;
    const uploadedCopies = backup.remoteCopies.filter((copy) => copy.provider === "s3" && copy.status === "uploaded");
    if (uploadedCopies.length === 0) return;

    const client = createS3Client(remote);
    for (const copy of uploadedCopies) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: copy.bucket,
          Key: copy.key,
        }),
      );
    }
  }

  async function captureSnapshotBundle(params: {
    initialRun: BackupRun;
    settings: BackupSettings;
    pruneExpired: boolean;
    uploadRemote: boolean;
    sign: boolean;
  }): Promise<BackupRun> {
    let run = params.initialRun;
    snapshotBarrierActive = true;
    try {
      const components: BackupComponentResult[] = [
        await (async () => {
          try {
            const dbDir = path.resolve(run.bundlePath, "database");
            const dbResult = await runDatabaseBackup({
              connectionString: opts.connectionString,
              backupDir: dbDir,
              retentionDays: 3650,
              filenamePrefix: "database",
            });
            return {
              key: "database" as const,
              label: "Database",
              status: "included" as const,
              relativePath: path.relative(run.bundlePath, dbResult.backupFile),
              absolutePath: dbResult.backupFile,
              sizeBytes: dbResult.sizeBytes,
              itemCount: 1,
              notes: null,
            };
          } catch (error) {
            return {
              key: "database" as const,
              label: "Database",
              status: "failed" as const,
              relativePath: null,
              absolutePath: null,
              sizeBytes: 0,
              itemCount: 0,
              notes: error instanceof Error ? error.message : String(error),
            };
          }
        })(),
      ];

      run = { ...run, components };
      await writeManifest(run);

      for (const target of resolveSnapshotTargets(params.settings)) {
        let component: BackupComponentResult;
        try {
          component = target.key === "config"
            ? await snapshotConfig(run.bundlePath, target)
            : await snapshotPath(run.bundlePath, target);
        } catch (error) {
          component = {
            key: target.key,
            label: target.label,
            status: "failed",
            relativePath: null,
            absolutePath: null,
            sizeBytes: 0,
            itemCount: 0,
            notes: error instanceof Error ? error.message : String(error),
          };
        }
        components.push(component);
        run = { ...run, components: [...components] };
        await writeManifest(run);
      }

      snapshotBarrierActive = false;

      const containsSensitiveData = containsSensitiveComponents(components);
      const hasHardFailure = components.some((component) => component.status === "failed");
      const totalSize = (await collectPathStats(run.bundlePath)).sizeBytes;
      const prunedCount = params.pruneExpired
        ? await pruneExpiredBackups(params.settings.directory, params.settings.retentionDays, run.bundleName)
          + await pruneExpiredRestoreCheckpoints(params.settings.directory, params.settings.retentionDays)
        : 0;
      const finishedAt = nowIso();
      const integrity = hasHardFailure
        ? null
        : await computeBackupIntegrity({
          ...run,
          bundlePath: run.bundlePath,
          components,
        });

      if (params.sign && params.settings.requireSignedBackups && !opts.config.backupSigningSecret) {
        throw new Error("Backup signing is required, but PAPERCLIP_BACKUP_SIGNING_SECRET is not configured.");
      }

      const signature = params.sign && integrity && opts.config.backupSigningSecret
        ? signBackupRun({
          run: {
            ...run,
            status: hasHardFailure ? "failed" : "succeeded",
            finishedAt,
            totalSizeBytes: totalSize,
            prunedCount,
            error: hasHardFailure ? "One or more requested backup components failed." : null,
            containsSensitiveData,
            integrity,
            signature: null,
            remoteCopies: [],
            components,
          },
          secret: opts.config.backupSigningSecret,
          keyId: opts.config.backupSigningKeyId ?? null,
        })
        : null;

      const remoteCopies = !hasHardFailure && params.uploadRemote
        ? await uploadRemoteCopies(
          {
            ...run,
            status: "succeeded",
            finishedAt,
            totalSizeBytes: totalSize,
            prunedCount,
            error: null,
            containsSensitiveData,
            integrity,
            signature,
            remoteCopies: [],
            components,
          },
          params.settings,
        )
        : [];
      const remoteFailure = remoteCopies.find((copy) => copy.status === "failed")?.notes ?? null;

      run = backupRunSchema.parse({
        ...run,
        status: hasHardFailure || remoteFailure ? "failed" : "succeeded",
        finishedAt,
        totalSizeBytes: totalSize,
        prunedCount,
        error: remoteFailure ?? (hasHardFailure ? "One or more requested backup components failed." : null),
        containsSensitiveData,
        integrity,
        signature,
        remoteCopies,
        components,
      });
      await writeManifest(run);
      return run;
    } catch (error) {
      const totalSize = (await pathExists(run.bundlePath)) ? (await collectPathStats(run.bundlePath)).sizeBytes : 0;
      run = backupRunSchema.parse({
        ...run,
        status: "failed",
        finishedAt: nowIso(),
        totalSizeBytes: totalSize,
        error: error instanceof Error ? error.message : String(error),
        containsSensitiveData: containsSensitiveComponents(run.components),
        signature: run.signature ?? null,
        remoteCopies: run.remoteCopies ?? [],
        components: run.components,
      });
      await writeManifest(run);
      throw error;
    } finally {
      snapshotBarrierActive = false;
    }
  }

  async function pruneExpiredBackups(directory: string, retentionDays: number, keepBundleName: string): Promise<number> {
    if (!existsSync(directory)) return 0;
    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    const backups = await listBackups(directory);
    let prunedCount = 0;

    for (const backup of backups) {
      if (backup.bundleName === keepBundleName) continue;
      if (backup.archivedAt) continue;
      const referenceTime = getRetentionReferenceTime(backup);
      if (new Date(referenceTime).getTime() >= cutoff) continue;
      await rm(backup.bundlePath, { recursive: true, force: true });
      prunedCount += 1;
    }

    return prunedCount;
  }

  async function pruneExpiredRestoreCheckpoints(directory: string, retentionDays: number): Promise<number> {
    const checkpointDirectory = path.resolve(directory, BACKUP_CHECKPOINT_DIRNAME);
    if (!existsSync(checkpointDirectory)) return 0;

    const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
    const checkpoints = await scanBackupDirectory(checkpointDirectory);
    let prunedCount = 0;

    for (const checkpoint of checkpoints) {
      const referenceTime = getRetentionReferenceTime(checkpoint);
      if (new Date(referenceTime).getTime() >= cutoff) continue;
      await rm(checkpoint.bundlePath, { recursive: true, force: true });
      prunedCount += 1;
    }

    return prunedCount;
  }

  async function getBackupById(backupId: string): Promise<BackupRun> {
    const settings = await readSettings();
    const backups = await listBackups(settings.directory);
    const backup = backups.find((entry) => entry.id === backupId);
    if (!backup) {
      throw notFound(`Backup '${backupId}' was not found.`);
    }
    return backup;
  }

  async function prepareImportedRun(
    imported: BackupRun,
    bundlePath: string,
    bundleName: string,
  ): Promise<BackupRun> {
    if (imported.status === "running") {
      throw new Error("Cannot import a backup archive that is still running.");
    }

    const components: BackupComponentResult[] = [];
    for (const component of imported.components) {
      let absolutePath: string | null = null;
      if (component.relativePath) {
        absolutePath = path.resolve(bundlePath, component.relativePath);
        if (!isPathInside(bundlePath, absolutePath)) {
          throw new Error(`Backup component '${component.key}' resolves outside the bundle.`);
        }
        if (!(await pathExists(absolutePath))) {
          if (component.status === "included") {
            throw new Error(`Backup component '${component.key}' is missing from the archive bundle.`);
          }
          absolutePath = null;
        }
      } else if (component.status === "included") {
        throw new Error(`Backup component '${component.key}' is missing a relative path in the manifest.`);
      }

      components.push({
        ...component,
        absolutePath,
      });
    }

    return backupRunSchema.parse({
      ...imported,
      bundleName,
      bundlePath,
      totalSizeBytes: (await collectPathStats(bundlePath)).sizeBytes,
      components,
    });
  }

  function resolveSourceComponentPath(backup: BackupRun, component: BackupComponentResult): string {
    if (!component.relativePath) {
      throw new Error(`Backup component '${component.key}' does not have a source path in the bundle.`);
    }

    const sourcePath = path.resolve(backup.bundlePath, component.relativePath);
    if (!isPathInside(backup.bundlePath, sourcePath)) {
      throw new Error(`Backup component '${component.key}' resolves outside the bundle.`);
    }

    return sourcePath;
  }

  function buildBundleIntegrityFromComponents(
    components: BackupComponentIntegrity[],
    recordedAt: string = nowIso(),
  ): BackupBundleIntegrity {
    const sorted = [...components].sort((left, right) => left.key.localeCompare(right.key));
    const hash = createHash("sha256");
    let fileCount = 0;
    let totalBytes = 0;

    for (const component of sorted) {
      fileCount += component.fileCount;
      totalBytes += component.totalBytes;
      hash.update(component.key);
      hash.update("\0");
      hash.update(component.scope);
      hash.update("\0");
      hash.update(component.hash);
      hash.update("\0");
      hash.update(String(component.fileCount));
      hash.update("\0");
      hash.update(String(component.totalBytes));
      hash.update("\n");
    }

    return backupBundleIntegritySchema.parse({
      algorithm: "sha256",
      recordedAt,
      bundleHash: hash.digest("hex"),
      fileCount,
      totalBytes,
      components: sorted,
    });
  }

  function integrityMatches(expected: BackupBundleIntegrity, actual: BackupBundleIntegrity): boolean {
    if (expected.bundleHash !== actual.bundleHash) return false;
    if (expected.components.length !== actual.components.length) return false;
    return expected.components.every((component, index) => {
      const other = actual.components[index];
      return other
        && other.key === component.key
        && other.scope === component.scope
        && other.hash === component.hash
        && other.fileCount === component.fileCount
        && other.totalBytes === component.totalBytes;
    });
  }

  async function computeBackupIntegrity(backup: Pick<BackupRun, "bundlePath" | "components">): Promise<BackupBundleIntegrity> {
    const components: BackupComponentIntegrity[] = [];
    for (const component of backup.components) {
      if (component.status !== "included") continue;
      const sourcePath = resolveSourceComponentPath(backup as BackupRun, component);
      const digest = await computePathDigest(sourcePath);
      components.push({
        key: component.key,
        algorithm: "sha256",
        scope: digest.scope,
        hash: digest.hash,
        fileCount: digest.fileCount,
        totalBytes: digest.totalBytes,
      });
    }
    return buildBundleIntegrityFromComponents(components);
  }

  async function verifyBackupIntegrity(backup: BackupRun): Promise<{
    status: BackupIntegrityStatus;
    expectedBundleHash: string | null;
    actualBundleHash: string | null;
    issues: string[];
    components: Map<BackupComponentKey, {
      status: BackupIntegrityStatus;
      expectedHash: string | null;
      actualHash: string | null;
      issues: string[];
    }>;
  }> {
    const results = new Map<BackupComponentKey, {
      status: BackupIntegrityStatus;
      expectedHash: string | null;
      actualHash: string | null;
      issues: string[];
    }>();

    if (!backup.integrity) {
      for (const component of backup.components) {
        results.set(component.key, {
          status: component.status === "included" ? "missing" : "skipped",
          expectedHash: null,
          actualHash: null,
          issues: [],
        });
      }
      return {
        status: "missing",
        expectedBundleHash: null,
        actualBundleHash: null,
        issues: ["This snapshot does not have recorded integrity hashes."],
        components: results,
      };
    }

    const expectedByKey = new Map(backup.integrity.components.map((component) => [component.key, component]));
    const actualComponents: BackupComponentIntegrity[] = [];

    for (const key of RESTORE_COMPONENT_ORDER) {
      const component = backup.components.find((entry) => entry.key === key) ?? null;
      if (!component) {
        results.set(key, {
          status: "missing",
          expectedHash: expectedByKey.get(key)?.hash ?? null,
          actualHash: null,
          issues: [`Component '${RESTORE_COMPONENT_LABELS[key]}' is missing from the manifest.`],
        });
        continue;
      }

      if (component.status !== "included") {
        results.set(key, {
          status: "skipped",
          expectedHash: null,
          actualHash: null,
          issues: [],
        });
        continue;
      }

      const expected = expectedByKey.get(key) ?? null;
      if (!expected) {
        results.set(key, {
          status: "missing",
          expectedHash: null,
          actualHash: null,
          issues: [`Recorded integrity is missing for '${component.label}'.`],
        });
        continue;
      }

      try {
        const sourcePath = resolveSourceComponentPath(backup, component);
        const digest = await computePathDigest(sourcePath);
        actualComponents.push({
          key,
          algorithm: "sha256",
          scope: digest.scope,
          hash: digest.hash,
          fileCount: digest.fileCount,
          totalBytes: digest.totalBytes,
        });

        const issues: string[] = [];
        let status: BackupIntegrityStatus = "verified";
        if (
          expected.hash !== digest.hash
          || expected.scope !== digest.scope
          || expected.fileCount !== digest.fileCount
          || expected.totalBytes !== digest.totalBytes
        ) {
          status = "mismatch";
          issues.push(`Integrity mismatch for '${component.label}'.`);
        }

        results.set(key, {
          status,
          expectedHash: expected.hash,
          actualHash: digest.hash,
          issues,
        });
      } catch (error) {
        results.set(key, {
          status: "error",
          expectedHash: expected.hash,
          actualHash: null,
          issues: [error instanceof Error ? error.message : String(error)],
        });
      }
    }

    const issues = Array.from(results.values()).flatMap((result) => result.issues);
    const actualBundleHash =
      actualComponents.length === backup.integrity.components.length
        ? buildBundleIntegrityFromComponents(actualComponents, backup.integrity.recordedAt).bundleHash
        : null;

    let status: BackupIntegrityStatus = "verified";
    if (Array.from(results.values()).some((result) => result.status === "error")) {
      status = "error";
    } else if (Array.from(results.values()).some((result) => result.status === "mismatch")) {
      status = "mismatch";
    } else if (Array.from(results.values()).some((result) => result.status === "missing")) {
      status = "missing";
    }

    if (actualBundleHash && actualBundleHash !== backup.integrity.bundleHash) {
      status = "mismatch";
      issues.push("Bundle integrity hash does not match the recorded manifest.");
    }

    return {
      status,
      expectedBundleHash: backup.integrity.bundleHash,
      actualBundleHash,
      issues,
      components: results,
    };
  }

  async function collectRestoreValidationIssues(opts: {
    backup: BackupRun;
    source: BackupComponentResult | null;
    fallback: { key: BackupComponentKey; label: string };
    expectedKind: RestorePathKind;
    destinationPath?: string | null;
    required?: boolean;
  }): Promise<string[]> {
    const { backup, source, fallback, expectedKind, destinationPath, required = false } = opts;
    if (!source) {
      return required ? [`Backup is missing the required '${fallback.label}' component.`] : [];
    }

    if (source.status !== "included") {
      return required
        ? [`Backup cannot be restored because '${source.label}' is marked as ${source.status}.`]
        : [];
    }

    const issues: string[] = [];
    try {
      const sourcePath = resolveSourceComponentPath(backup, source);
      const sourceStat = await stat(sourcePath);
      if (expectedKind === "file" && !sourceStat.isFile()) {
        issues.push(`Backup component '${source.label}' must be a file.`);
      }
      if (expectedKind === "directory" && !sourceStat.isDirectory()) {
        issues.push(`Backup component '${source.label}' must be a directory.`);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }

    if (destinationPath && isPathInside(destinationPath, backup.bundlePath)) {
      issues.push(
        `Restore target for '${source.label}' would delete the backup bundle itself. Move the backup directory outside the destination path first.`,
      );
    }

    return issues;
  }

  async function buildRestorePreview(backup: BackupRun, settings: BackupSettings): Promise<BackupRestorePreview> {
    const checkedAt = nowIso();
    const sourceByKey = new Map(backup.components.map((component) => [component.key, component]));
    const integrity = await verifyBackupIntegrity(backup);
    const signature = verifyBackupSignature({
      run: backup,
      secret: opts.config.backupSigningSecret,
    });
    const previewComponents: BackupRestorePreviewComponent[] = [];
    const issues: string[] = [];

    if (backup.status !== "succeeded") {
      issues.push("Only successful snapshots can be restored.");
    }
    if (["mismatch", "error"].includes(signature.status)) {
      issues.push(signature.issues[0] ?? "Snapshot signature verification failed.");
    }
    if (settings.requireSignedBackups && signature.status !== "verified") {
      issues.push("This instance requires signed backups, and this snapshot did not pass signature verification.");
    }

    for (const key of RESTORE_COMPONENT_ORDER) {
      const source = sourceByKey.get(key) ?? null;
      const label = source?.label ?? RESTORE_COMPONENT_LABELS[key];
      const destinationPath =
        key === "database"
          ? null
          : key === "config"
            ? instanceRoot
            : resolveRestoreDestinationPath(key);
      const validationIssues = await collectRestoreValidationIssues({
        backup,
        source,
        fallback: { key, label },
        expectedKind:
          key === "database" || key === "env" || key === "secretsKey"
            ? "file"
            : "directory",
        destinationPath: key === "config" ? null : destinationPath,
        required: key === "database",
      });
      const integrityResult = integrity.components.get(key) ?? {
        status: source?.status === "included" ? "missing" : "skipped",
        expectedHash: null,
        actualHash: null,
        issues: source?.status === "included" ? ["This component does not have recorded integrity hashes."] : [],
      };
      const componentIssues = [...validationIssues, ...integrityResult.issues];
      if (componentIssues.length > 0) {
        issues.push(...componentIssues);
      }

      previewComponents.push({
        key,
        label,
        sourceStatus: source?.status ?? "missing",
        action: source?.status === "included" ? "restore" : "skip",
        destinationPath,
        integrityStatus: integrityResult.status,
        expectedHash: integrityResult.expectedHash,
        actualHash: integrityResult.actualHash,
        issues: componentIssues,
        notes: source?.notes ?? null,
      });
    }

    const canRestore =
      backup.status === "succeeded"
      && !previewComponents.some((component) => component.issues.length > 0 && component.action === "restore")
      && !["mismatch", "error"].includes(integrity.status)
      && !["mismatch", "error"].includes(signature.status)
      && (!settings.requireSignedBackups || signature.status === "verified");

    return backupRestorePreviewSchema.parse({
      backupId: backup.id,
      bundleName: backup.bundleName,
      backupStatus: backup.status,
      canRestore,
      checkedAt,
      issues: Array.from(new Set(issues)),
      integrity: {
        status: integrity.status,
        expectedBundleHash: integrity.expectedBundleHash,
        actualBundleHash: integrity.actualBundleHash,
        issues: Array.from(new Set(integrity.issues)),
      },
      signature: {
        status: signature.status,
        keyId: signature.keyId,
        issues: Array.from(new Set(signature.issues)),
      },
      components: previewComponents,
    });
  }

  function resolveRestoreDestinationPath(key: Exclude<BackupComponentKey, "database">): string {
    switch (key) {
      case "storage":
        return opts.config.storageLocalDiskBaseDir;
      case "config":
        return instanceRoot;
      case "env":
        return resolvePaperclipEnvPath();
      case "secretsKey":
        return opts.config.secretsMasterKeyFilePath || resolveDefaultSecretsKeyFilePath();
      case "workspaces":
        return path.resolve(instanceRoot, "workspaces");
    }
  }

  async function runRestorePreflight(backup: BackupRun): Promise<BackupRestorePreview> {
    if (!(await pathExists(backup.bundlePath))) {
      throw new Error(`Backup bundle '${backup.bundleName}' is missing from disk.`);
    }

    const preview = await buildRestorePreview(backup, await readSettings());
    if (!preview.canRestore) {
      throw new Error(preview.issues[0] ?? "Restore preflight failed.");
    }
    return preview;
  }

  async function writeRestorePreflightFailure(backup: BackupRun, errorMessage: string): Promise<void> {
    await writeRestoreState({
      status: "failed",
      sourceBackupId: backup.id,
      sourceBundleName: backup.bundleName,
      startedAt: nowIso(),
      finishedAt: nowIso(),
      error: errorMessage,
      notes: "Restore preflight failed. No instance data was modified.",
      rollback: {
        status: "not_needed",
        checkpointBackupId: null,
        checkpointBundleName: null,
        error: null,
        finishedAt: null,
      },
      restoredComponents: [],
    });
  }

  function cloneRestoreComponent(
    source: BackupComponentResult | null,
    fallback: { key: BackupComponentKey; label: string },
    overrides: Partial<BackupComponentResult> = {},
  ): BackupComponentResult {
    return {
      key: fallback.key,
      label: fallback.label,
      status: source?.status ?? "missing",
      relativePath: source?.relativePath ?? null,
      absolutePath: source?.absolutePath ?? null,
      sizeBytes: source?.sizeBytes ?? null,
      itemCount: source?.itemCount ?? null,
      notes: source?.notes ?? null,
      ...overrides,
    };
  }

  async function restoreDatabaseComponent(
    backup: BackupRun,
    source: BackupComponentResult | null,
  ): Promise<BackupComponentResult> {
    if (!source) {
      return cloneRestoreComponent(source, { key: "database", label: "Database" }, {
        status: "missing",
        notes: "Source backup does not include a database component.",
        sizeBytes: 0,
        itemCount: 0,
      });
    }

    if (source.status !== "included") {
      return cloneRestoreComponent(source, { key: source.key, label: source.label }, {
        absolutePath: null,
        notes: joinNotes(source.notes, `Database restore skipped because the source backup marked this component as ${source.status}.`),
      });
    }

    try {
      const backupFile = resolveSourceComponentPath(backup, source);
      if (!(await pathExists(backupFile))) {
        return cloneRestoreComponent(source, { key: source.key, label: source.label }, {
          status: "missing",
          absolutePath: null,
          sizeBytes: 0,
          itemCount: 0,
          notes: joinNotes(source.notes, "Database snapshot file is missing from the bundle."),
        });
      }

      const result = await restoreDatabaseBackup({
        connectionString: opts.connectionString,
        backupFile,
        dropExistingSchema: true,
      });

      return cloneRestoreComponent(source, { key: source.key, label: source.label }, {
        status: "included",
        absolutePath: null,
        sizeBytes: result.sizeBytes,
        itemCount: 1,
      });
    } catch (error) {
      return cloneRestoreComponent(source, { key: source.key, label: source.label }, {
        status: "failed",
        absolutePath: null,
        sizeBytes: 0,
        itemCount: 0,
        notes: joinNotes(source.notes, error instanceof Error ? error.message : String(error)),
      });
    }
  }

  async function restorePathComponent(opts: {
    backup: BackupRun;
    source: BackupComponentResult | null;
    fallback: { key: Exclude<BackupComponentKey, "database">; label: string };
    destinationPath: string;
  }): Promise<BackupComponentResult> {
    const { backup, source, fallback, destinationPath } = opts;

    if (!source) {
      return cloneRestoreComponent(source, fallback, {
        status: "missing",
        absolutePath: destinationPath,
        sizeBytes: 0,
        itemCount: 0,
        notes: "Source backup does not include this component.",
      });
    }

    if (source.status !== "included") {
      return cloneRestoreComponent(source, fallback, {
        absolutePath: destinationPath,
        notes: joinNotes(source.notes, `Restore skipped because the source backup marked this component as ${source.status}.`),
      });
    }

    try {
      const sourcePath = resolveSourceComponentPath(backup, source);
      if (!(await pathExists(sourcePath))) {
        return cloneRestoreComponent(source, fallback, {
          status: "missing",
          absolutePath: destinationPath,
          sizeBytes: 0,
          itemCount: 0,
          notes: joinNotes(source.notes, "Source path is missing from the bundle."),
        });
      }

      if (isPathInside(destinationPath, backup.bundlePath)) {
        return cloneRestoreComponent(source, fallback, {
          status: "failed",
          absolutePath: destinationPath,
          sizeBytes: 0,
          itemCount: 0,
          notes: joinNotes(source.notes, "Restore target contains the source bundle, so replacing it would destroy the backup in use."),
        });
      }

      const sourceStat = await stat(sourcePath);
      await rm(destinationPath, { recursive: true, force: true });
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath, {
        recursive: sourceStat.isDirectory(),
        force: true,
        preserveTimestamps: true,
      });

      const restoredStats = await collectPathStats(destinationPath);
      return cloneRestoreComponent(source, fallback, {
        status: "included",
        absolutePath: destinationPath,
        sizeBytes: restoredStats.sizeBytes,
        itemCount: restoredStats.itemCount,
      });
    } catch (error) {
      return cloneRestoreComponent(source, fallback, {
        status: "failed",
        absolutePath: destinationPath,
        sizeBytes: 0,
        itemCount: 0,
        notes: joinNotes(source.notes, error instanceof Error ? error.message : String(error)),
      });
    }
  }

  async function restoreConfigComponent(
    backup: BackupRun,
    source: BackupComponentResult | null,
  ): Promise<BackupComponentResult> {
    const destinationRoot = instanceRoot;
    const fallback = { key: "config" as const, label: "Instance config" };

    if (!source) {
      return cloneRestoreComponent(source, fallback, {
        status: "missing",
        absolutePath: destinationRoot,
        sizeBytes: 0,
        itemCount: 0,
        notes: "Source backup does not include instance config.",
      });
    }

    if (source.status !== "included") {
      return cloneRestoreComponent(source, fallback, {
        absolutePath: destinationRoot,
        notes: joinNotes(source.notes, `Restore skipped because the source backup marked this component as ${source.status}.`),
      });
    }

    try {
      const sourceDir = resolveSourceComponentPath(backup, source);
      if (!(await pathExists(sourceDir))) {
        return cloneRestoreComponent(source, fallback, {
          status: "missing",
          absolutePath: destinationRoot,
          sizeBytes: 0,
          itemCount: 0,
          notes: joinNotes(source.notes, "Config directory is missing from the bundle."),
        });
      }

      const files = [
        {
          label: "config.json",
          sourcePath: path.resolve(sourceDir, "config.json"),
          destinationPath: resolvePaperclipConfigPath(),
        },
        {
          label: SETTINGS_FILENAME,
          sourcePath: path.resolve(sourceDir, SETTINGS_FILENAME),
          destinationPath: settingsPath,
        },
      ];

      let copied = 0;
      let sizeBytes = 0;
      const notes: string[] = [];

      for (const file of files) {
        if (!(await pathExists(file.sourcePath))) {
          notes.push(`Missing ${file.label} in the backup bundle`);
          continue;
        }
        await mkdir(path.dirname(file.destinationPath), { recursive: true });
        await cp(file.sourcePath, file.destinationPath, {
          force: true,
          preserveTimestamps: true,
        });
        const fileStat = await stat(file.destinationPath);
        sizeBytes += fileStat.size;
        copied += 1;
      }

      if (copied === 0) {
        return cloneRestoreComponent(source, fallback, {
          status: "missing",
          absolutePath: destinationRoot,
          sizeBytes: 0,
          itemCount: 0,
          notes: joinNotes(source.notes, notes.join("; "), "No config files were restored."),
        });
      }

      return cloneRestoreComponent(source, fallback, {
        status: "included",
        absolutePath: destinationRoot,
        sizeBytes,
        itemCount: copied,
        notes: joinNotes(
          source.notes,
          notes.join("; "),
          "Restart the server if the restored config changes runtime settings.",
        ),
      });
    } catch (error) {
      return cloneRestoreComponent(source, fallback, {
        status: "failed",
        absolutePath: destinationRoot,
        sizeBytes: 0,
        itemCount: 0,
        notes: joinNotes(source.notes, error instanceof Error ? error.message : String(error)),
      });
    }
  }

  async function createRestoreCheckpoint(settings: BackupSettings, actorId: string | null): Promise<BackupRun> {
    const checkpointDirectory = path.resolve(settings.directory, BACKUP_CHECKPOINT_DIRNAME);
    await mkdir(checkpointDirectory, { recursive: true });

    const startedAt = new Date();
    const runId = randomUUID();
    const bundleName = `checkpoint-${bundleTimestamp(startedAt)}-${runId.slice(0, 8)}`;
    const bundlePath = path.resolve(checkpointDirectory, bundleName);
    const initialRun = backupRunSchema.parse({
      id: runId,
      origin: "local",
      status: "running",
      triggerSource: "manual",
      startedAt: nowIso(startedAt),
      finishedAt: null,
      bundleName,
      bundlePath,
      totalSizeBytes: 0,
      prunedCount: 0,
      error: null,
      importedAt: null,
      importedBy: null,
      importSourceFilename: null,
      archivedAt: null,
      archivedBy: null,
      containsSensitiveData: false,
      integrity: null,
      signature: null,
      remoteCopies: [],
      components: [],
    });

    await mkdir(bundlePath, { recursive: true });
    await writeManifest(initialRun);
    await appendAuditEvent({
      action: "backup.restore.checkpoint.started",
      result: "started",
      actorId,
      backupId: initialRun.id,
      bundleName: initialRun.bundleName,
      details: {
        bundlePath: initialRun.bundlePath,
      },
    });

    const checkpointSettings = backupSettingsSchema.parse({
      ...settings,
      directory: checkpointDirectory,
      requireSignedBackups: false,
      remote: {
        provider: "none",
        s3: settings.remote.s3,
      },
    });
    const checkpoint = await captureSnapshotBundle({
      initialRun,
      settings: checkpointSettings,
      pruneExpired: false,
      uploadRemote: false,
      sign: false,
    });
    await appendAuditEvent({
      action: "backup.restore.checkpoint.completed",
      result: checkpoint.status === "succeeded" ? "succeeded" : "failed",
      actorId,
      backupId: checkpoint.id,
      bundleName: checkpoint.bundleName,
      details: {
        totalSizeBytes: checkpoint.totalSizeBytes,
        error: checkpoint.error,
      },
    });
    if (checkpoint.status !== "succeeded") {
      throw new Error(checkpoint.error ?? "Failed to create a rollback checkpoint before restore.");
    }
    return checkpoint;
  }

  async function applyRestoreSequence(
    backup: BackupRun,
    onProgress?: (restoredComponents: BackupComponentResult[]) => Promise<void>,
  ): Promise<BackupComponentResult[]> {
    const sourceByKey = new Map(backup.components.map((component) => [component.key, component]));
    const restoredComponents: BackupComponentResult[] = [];
    const push = async (component: BackupComponentResult) => {
      restoredComponents.push(component);
      if (onProgress) {
        await onProgress([...restoredComponents]);
      }
    };

    const databaseResult = await restoreDatabaseComponent(backup, sourceByKey.get("database") ?? null);
    await push(databaseResult);
    if (databaseResult.status !== "included") {
      throw new Error(databaseResult.notes ?? "Database restore failed.");
    }

    await push(await restorePathComponent({
      backup,
      source: sourceByKey.get("storage") ?? null,
      fallback: { key: "storage", label: "Storage assets" },
      destinationPath: opts.config.storageLocalDiskBaseDir,
    }));
    await push(await restoreConfigComponent(backup, sourceByKey.get("config") ?? null));
    await push(await restorePathComponent({
      backup,
      source: sourceByKey.get("env") ?? null,
      fallback: { key: "env", label: "Instance env file" },
      destinationPath: resolvePaperclipEnvPath(),
    }));
    await push(await restorePathComponent({
      backup,
      source: sourceByKey.get("secretsKey") ?? null,
      fallback: { key: "secretsKey", label: "Secrets master key" },
      destinationPath: opts.config.secretsMasterKeyFilePath || resolveDefaultSecretsKeyFilePath(),
    }));
    await push(await restorePathComponent({
      backup,
      source: sourceByKey.get("workspaces") ?? null,
      fallback: { key: "workspaces", label: "Agent workspaces" },
      destinationPath: path.resolve(instanceRoot, "workspaces"),
    }));

    return restoredComponents;
  }

  async function runRollbackFromCheckpoint(
    checkpoint: BackupRun,
    state: BackupRestoreState,
    actorId: string | null,
  ): Promise<BackupRollbackState> {
    let rollback = backupRollbackStateSchema.parse({
      status: "running",
      checkpointBackupId: checkpoint.id,
      checkpointBundleName: checkpoint.bundleName,
      error: null,
      finishedAt: null,
    });
    await writeRestoreState({
      ...state,
      rollback,
    });
    await appendAuditEvent({
      action: "backup.restore.rollback.started",
      result: "started",
      actorId,
      backupId: checkpoint.id,
      bundleName: checkpoint.bundleName,
      details: {
        checkpointBundlePath: checkpoint.bundlePath,
      },
    });

    try {
      const results = await applyRestoreSequence(checkpoint);
      const failed = results[0]?.status !== "included" || results.some((component) => component.status === "failed");
      rollback = backupRollbackStateSchema.parse({
        ...rollback,
        status: failed ? "failed" : "succeeded",
        error: failed ? "Rollback checkpoint could not be fully restored." : null,
        finishedAt: nowIso(),
      });
      await appendAuditEvent({
        action: "backup.restore.rollback.completed",
        result: failed ? "failed" : "succeeded",
        actorId,
        backupId: checkpoint.id,
        bundleName: checkpoint.bundleName,
        details: {
          restoredComponentCount: results.length,
          error: rollback.error,
        },
      });
      return rollback;
    } catch (error) {
      rollback = backupRollbackStateSchema.parse({
        ...rollback,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: nowIso(),
      });
      await appendAuditEvent({
        action: "backup.restore.rollback.completed",
        result: "failed",
        actorId,
        backupId: checkpoint.id,
        bundleName: checkpoint.bundleName,
        details: {
          error: rollback.error,
        },
      });
      return rollback;
    }
  }

  function buildRestoreNotes(results: BackupComponentResult[]): string | null {
    const notes: string[] = [];
    if (results.some((component) => component.status === "included" && ["config", "env", "secretsKey"].includes(component.key))) {
      notes.push("Restart the server to apply restored config, env, or secrets key changes.");
    }
    if (results.some((component) => component.status === "failed")) {
      notes.push("The instance may be partially restored. Review component-level errors before continuing.");
    }
    if (results.some((component) => component.status === "missing" || component.status === "unsupported")) {
      notes.push("Some components were not present in the source snapshot and were left unchanged.");
    }
    return notes.length > 0 ? notes.join(" ") : null;
  }

  async function runRestore(backup: BackupRun, actorId: string | null): Promise<BackupRestoreState> {
    const initialState = await writeRestoreState({
      status: "running",
      sourceBackupId: backup.id,
      sourceBundleName: backup.bundleName,
      startedAt: nowIso(),
      finishedAt: null,
      error: null,
      notes: "Restore is running. Most API routes are temporarily unavailable until it finishes.",
      rollback: {
        status: "not_needed",
        checkpointBackupId: null,
        checkpointBundleName: null,
        error: null,
        finishedAt: null,
      },
      restoredComponents: [],
    });

    const execute = async (): Promise<BackupRestoreState> => {
      let state = initialState;
      let checkpoint: BackupRun | null = null;

      try {
        const settings = await readSettings();
        checkpoint = await createRestoreCheckpoint(settings, actorId);
        state = await writeRestoreState({
          ...state,
          notes: "Restore is running. Most API routes are temporarily unavailable until it finishes. A rollback checkpoint was captured first.",
          rollback: {
            status: "not_needed",
            checkpointBackupId: checkpoint.id,
            checkpointBundleName: checkpoint.bundleName,
            error: null,
            finishedAt: null,
          },
        });

        const restoredComponents = await applyRestoreSequence(backup, async (components) => {
          state = await writeRestoreState({
            ...state,
            restoredComponents: components,
          });
        });
        const hasHardFailure = restoredComponents.some((component) => component.status === "failed");
        let rollback = state.rollback;
        if (hasHardFailure && checkpoint) {
          rollback = await runRollbackFromCheckpoint(checkpoint, state, actorId);
        }
        const baseNotes = buildRestoreNotes(restoredComponents);
        state = await writeRestoreState({
          ...state,
          status: hasHardFailure ? "failed" : "succeeded",
          finishedAt: nowIso(),
          error: hasHardFailure ? "One or more requested restore components failed." : null,
          notes: joinNotes(
            rollback.status === "succeeded" ? null : baseNotes,
            hasHardFailure && checkpoint
              ? rollback.status === "succeeded"
                ? "Restore failed after applying some components, but the instance was rolled back to the pre-restore checkpoint."
                : "Restore failed after applying some components, and automatic rollback did not fully succeed. Manual recovery may be required."
              : null,
          ),
          rollback,
          restoredComponents,
        });
        await appendAuditEvent({
          action: "backup.restore.completed",
          result: state.status === "succeeded" ? "succeeded" : "failed",
          actorId,
          backupId: backup.id,
          bundleName: backup.bundleName,
          details: {
            rollbackCheckpoint: checkpoint?.bundleName ?? null,
            componentCount: state.restoredComponents.length,
            error: state.error,
            rollbackStatus: rollback.status,
            rollbackError: rollback.error,
          },
        });

        if ((state.status === "succeeded" || rollback.status === "succeeded") && checkpoint) {
          await rm(checkpoint.bundlePath, { recursive: true, force: true });
        }
        return state;
      } catch (error) {
        const existingComponents = state.restoredComponents;
        let rollback = state.rollback;
        if (checkpoint) {
          rollback = await runRollbackFromCheckpoint(checkpoint, state, actorId);
        }
        state = await writeRestoreState({
          ...state,
          status: "failed",
          finishedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
          notes: joinNotes(
            rollback.status === "succeeded" ? null : buildRestoreNotes(existingComponents),
            checkpoint
              ? rollback.status === "succeeded"
                ? "Restore failed, but the instance was rolled back to the pre-restore checkpoint."
                : "Restore failed and automatic rollback did not fully succeed. Manual recovery may be required."
              : "Restore stopped before all components were applied.",
          ),
          rollback,
          restoredComponents: existingComponents,
        });
        await appendAuditEvent({
          action: "backup.restore.completed",
          result: rollback.status === "succeeded" ? "failed" : "failed",
          actorId,
          backupId: backup.id,
          bundleName: backup.bundleName,
          details: {
            error: state.error,
            rollbackStatus: rollback.status,
            rollbackCheckpoint: checkpoint?.bundleName ?? null,
            rollbackError: rollback.error,
          },
        });
        if (checkpoint && rollback.status === "succeeded") {
          await rm(checkpoint.bundlePath, { recursive: true, force: true });
        }
        throw error;
      } finally {
        activeRestorePromise = null;
      }
    };

    activeRestorePromise = execute();
    void activeRestorePromise.then((state) => {
      logger.info(
        {
          backupId: backup.id,
          bundlePath: backup.bundlePath,
          status: state.status,
        },
        `Backup restore ${state.status}`,
      );
    }).catch((error) => {
      logger.error(
        {
          err: error,
          backupId: backup.id,
          bundlePath: backup.bundlePath,
        },
        "Backup restore failed",
      );
    });

    return initialState;
  }

  async function getOverview(): Promise<BackupOverview> {
    const settings = await readSettings();
    const backups = await listBackups(settings.directory);
    const latestSuccess = backups.find((backup) => backup.status === "succeeded") ?? null;
    const latestFailure = backups.find((backup) => backup.status === "failed") ?? null;
    const restore = await readRestoreState();
    const recentAuditEvents = await readRecentAuditEvents();
    const stats = backups.reduce(
      (acc, backup) => {
        acc.totalSnapshots += 1;
        acc.storedBytes += backup.totalSizeBytes;
        if (backup.status === "succeeded") acc.succeededSnapshots += 1;
        if (backup.status === "failed") acc.failedSnapshots += 1;
        return acc;
      },
      { totalSnapshots: 0, succeededSnapshots: 0, failedSnapshots: 0, storedBytes: 0 },
    );
    const nextScheduledAt = !settings.enabled
      ? null
      : lastAutomaticRunAt
        ? new Date(new Date(lastAutomaticRunAt).getTime() + settings.intervalMinutes * 60_000).toISOString()
        : new Date(schedulerAnchorAt.getTime() + settings.intervalMinutes * 60_000).toISOString();

    return backupOverviewSchema.parse({
      settings,
      security: {
        signingConfigured: Boolean(opts.config.backupSigningSecret),
        signingKeyId: opts.config.backupSigningKeyId ?? null,
        signingRequired: settings.requireSignedBackups,
        writeBarrierMode: "pause_mutations",
        remoteReplicationConfigured: settings.remote.provider !== "none",
        remoteReplicationHealthy:
          settings.remote.provider === "none"
            ? null
            : Boolean(latestSuccess?.remoteCopies.some((copy) => copy.status === "uploaded")),
      },
      audit: backupAuditSummarySchema.parse({
        path: auditLogPath,
        recentEvents: recentAuditEvents,
      }),
      scheduler: {
        running: activeRunId !== null,
        activeRunId,
        activeRunStartedAt,
        nextScheduledAt,
        lastAutomaticRunAt,
      },
      restore,
      support: getSupport(),
      stats,
      latestSuccess,
      latestFailure,
      backups,
    });
  }

  async function updateSettings(patch: UpdateBackupSettings, actorId: string | null): Promise<BackupSettings> {
    if (activeRunPromise) {
      throw conflict("Cannot update backup settings while a backup is running.");
    }
    await ensureRestoreIdle("update backup settings");

    const current = await readSettings();
    const next = backupSettingsSchema.parse({
      ...current,
      ...patch,
      components: {
        ...current.components,
        ...(patch.components ?? {}),
      },
      remote: {
        ...current.remote,
        ...(patch.remote ?? {}),
        s3: {
          ...current.remote.s3,
          ...(patch.remote?.s3 ?? {}),
        },
      },
      updatedAt: nowIso(),
      updatedBy: actorId,
    });

    if (next.requireSignedBackups && !opts.config.backupSigningSecret) {
      throw unprocessable("Signed backups are required, but PAPERCLIP_BACKUP_SIGNING_SECRET is not configured on this instance.");
    }

    if (!current.enabled && next.enabled) {
      schedulerAnchorAt = new Date();
    }

    await appendAuditEvent({
      action: "backup.settings.updated",
      result: "succeeded",
      actorId,
      details: {
        enabled: next.enabled,
        intervalMinutes: next.intervalMinutes,
        retentionDays: next.retentionDays,
        requireSignedBackups: next.requireSignedBackups,
        remoteProvider: next.remote.provider,
      },
    });

    return writeSettings(next);
  }

  async function startBackup(triggerSource: BackupTriggerSource, actorId: string | null): Promise<BackupRun> {
    if (activeRunPromise) {
      throw conflict("A backup is already running.");
    }
    await ensureRestoreIdle("start a backup");

    const settings = await readSettings();
    await mkdir(settings.directory, { recursive: true });

    const startedAt = new Date();
    const runId = randomUUID();
    const bundleName = `${bundleTimestamp(startedAt)}-${runId.slice(0, 8)}`;
    const bundlePath = path.resolve(settings.directory, bundleName);
    const initialRun: BackupRun = {
      id: runId,
      origin: "local",
      status: "running",
      triggerSource,
      startedAt: nowIso(startedAt),
      finishedAt: null,
      bundleName,
      bundlePath,
      totalSizeBytes: 0,
      prunedCount: 0,
      error: null,
      importedAt: null,
      importedBy: null,
      importSourceFilename: null,
      archivedAt: null,
      archivedBy: null,
      containsSensitiveData: false,
      integrity: null,
      signature: null,
      remoteCopies: [],
      components: [],
    };

    await mkdir(bundlePath, { recursive: true });
    await writeManifest(initialRun);

    activeRunId = runId;
    activeRunStartedAt = initialRun.startedAt;
    if (triggerSource === "scheduler") {
      lastAutomaticRunAt = initialRun.startedAt;
    }

    const execute = async (): Promise<BackupRun> => {
      try {
        await appendAuditEvent({
          action: "backup.snapshot.started",
          result: "started",
          actorId,
          backupId: initialRun.id,
          bundleName: initialRun.bundleName,
          details: {
            triggerSource,
            remoteProvider: settings.remote.provider,
            requireSignedBackups: settings.requireSignedBackups,
          },
        });
        const run = await captureSnapshotBundle({
          initialRun,
          settings,
          pruneExpired: true,
          uploadRemote: true,
          sign: true,
        });
        await appendAuditEvent({
          action: "backup.snapshot.completed",
          result: run.status === "succeeded" ? "succeeded" : "failed",
          actorId,
          backupId: run.id,
          bundleName: run.bundleName,
          details: {
            totalSizeBytes: run.totalSizeBytes,
            prunedCount: run.prunedCount,
            remoteCopies: run.remoteCopies.length,
            containsSensitiveData: run.containsSensitiveData,
            signed: Boolean(run.signature),
            error: run.error,
          },
        });
        return run;
      } catch (error) {
        await appendAuditEvent({
          action: "backup.snapshot.completed",
          result: "failed",
          actorId,
          backupId: initialRun.id,
          bundleName: initialRun.bundleName,
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      } finally {
        activeRunId = null;
        activeRunStartedAt = null;
        activeRunPromise = null;
      }
    };

    activeRunPromise = execute();
    void activeRunPromise.then((run) => {
      logger.info(
        {
          runId: run.id,
          triggerSource,
          bundlePath: run.bundlePath,
          totalSizeBytes: run.totalSizeBytes,
          prunedCount: run.prunedCount,
          actorId,
        },
        `Backup ${run.status}`,
      );
    }).catch((error) => {
      logger.error(
        {
          err: error,
          runId,
          triggerSource,
          bundlePath,
          actorId,
        },
        "Backup failed",
      );
    });

    return initialRun;
  }

  async function createManualBackup(actorId: string | null): Promise<BackupRun> {
    return startBackup("manual", actorId);
  }

  async function importBackupArchive(
    archivePath: string,
    originalFilename: string | null,
    actorId: string | null,
  ): Promise<BackupRun> {
    if (activeRunPromise) {
      throw conflict("Cannot import a backup while a backup is running.");
    }
    await ensureRestoreIdle("import a backup");

    if (!(await pathExists(archivePath))) {
      throw notFound("Uploaded backup archive was not found on disk.");
    }

    const settings = await readSettings();
    await mkdir(settings.directory, { recursive: true });

    const existingBackups = await listBackups(settings.directory);
    const existingIds = new Set(existingBackups.map((backup) => backup.id));
    const existingBundleNames = new Set(existingBackups.map((backup) => backup.bundleName));

    const inspection = await inspectImportedArchive(archivePath);

    if (existingBundleNames.has(inspection.bundleName)) {
      throw conflict(`Backup bundle '${inspection.bundleName}' already exists on this instance.`);
    }

    const stagingRoot = path.resolve(instanceRoot, "tmp", "backup-imports", randomUUID());
    await mkdir(stagingRoot, { recursive: true });

    try {
      await runCommand("tar", ["-xzf", archivePath, "-C", stagingRoot]);
      const extractedBundlePath = path.resolve(stagingRoot, inspection.bundleName);
      if (!(await pathExists(extractedBundlePath))) {
        throw new Error("Backup archive did not extract a bundle directory.");
      }

      await assertNoSymlinks(extractedBundlePath);

      const manifestPath = path.resolve(extractedBundlePath, MANIFEST_FILENAME);
      const rawManifest = await readJsonFile<unknown>(manifestPath);
      if (!rawManifest) {
        throw new Error("Backup archive is missing manifest.json.");
      }
      const parsedManifest = backupRunSchema.safeParse(rawManifest);
      if (!parsedManifest.success) {
        throw new Error("Backup archive manifest.json is invalid.");
      }
      if (existingIds.has(parsedManifest.data.id)) {
        throw conflict(`Backup '${parsedManifest.data.id}' already exists on this instance.`);
      }

      const finalBundlePath = path.resolve(settings.directory, inspection.bundleName);
      const importedRun = await prepareImportedRun(parsedManifest.data, extractedBundlePath, inspection.bundleName);
      const computedIntegrity = await computeBackupIntegrity(importedRun);
      if (parsedManifest.data.integrity && !integrityMatches(parsedManifest.data.integrity, computedIntegrity)) {
        throw new Error("Imported backup integrity does not match the recorded manifest.");
      }
      const signature = verifyBackupSignature({
        run: importedRun,
        secret: opts.config.backupSigningSecret,
      });
      if (["mismatch", "error"].includes(signature.status)) {
        throw new Error(signature.issues[0] ?? "Imported backup signature verification failed.");
      }
      if (settings.requireSignedBackups && signature.status !== "verified") {
        throw new Error("This instance requires signed backups, and the imported archive could not be verified.");
      }
      const finalRun = backupRunSchema.parse({
        ...importedRun,
        origin: "imported",
        bundlePath: finalBundlePath,
        importedAt: nowIso(),
        importedBy: actorId,
        importSourceFilename: originalFilename,
        archivedAt: null,
        archivedBy: null,
        integrity: computedIntegrity,
        components: importedRun.components.map((component) => ({
          ...component,
          absolutePath: component.relativePath ? path.resolve(finalBundlePath, component.relativePath) : null,
        })),
      });

      await rename(extractedBundlePath, finalBundlePath);
      await writeManifest(finalRun);

      logger.info(
        {
          backupId: finalRun.id,
          bundleName: finalRun.bundleName,
          bundlePath: finalRun.bundlePath,
          totalSizeBytes: finalRun.totalSizeBytes,
          actorId,
          originalFilename,
          importedEntries: inspection.entryCount,
        },
        "Backup imported",
      );
      await appendAuditEvent({
        action: "backup.imported",
        result: "succeeded",
        actorId,
        backupId: finalRun.id,
        bundleName: finalRun.bundleName,
        details: {
          originalFilename,
          importedEntries: inspection.entryCount,
          signatureStatus: signature.status,
          signed: Boolean(finalRun.signature),
        },
      });

      return finalRun;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  async function previewRestore(backupId: string): Promise<BackupRestorePreview> {
    const backup = await getBackupById(backupId);
    return buildRestorePreview(backup, await readSettings());
  }

  async function archiveBackup(backupId: string, actorId: string | null): Promise<BackupHistoryActionResult> {
    if (activeRunPromise) {
      throw conflict("Cannot archive a backup while a backup is running.");
    }
    await ensureRestoreIdle("archive a backup");

    const settings = await readSettings();
    const backup = await getBackupById(backupId);
    if (backup.status === "running") {
      throw conflict("Cannot archive a backup while it is still running.");
    }
    if (backup.archivedAt) {
      throw conflict("Backup is already archived.");
    }
    if (!(await pathExists(backup.bundlePath))) {
      throw notFound(`Backup bundle '${backup.bundleName}' is missing from disk.`);
    }

    const archiveDirectory = path.resolve(settings.directory, BACKUP_ARCHIVE_DIRNAME);
    const archivedBundlePath = path.resolve(archiveDirectory, backup.bundleName);
    if (await pathExists(archivedBundlePath)) {
      throw conflict(`Archived backup bundle '${backup.bundleName}' already exists.`);
    }

    await mkdir(archiveDirectory, { recursive: true });
    await rename(backup.bundlePath, archivedBundlePath);

    const archivedRun = backupRunSchema.parse({
      ...backup,
      bundlePath: archivedBundlePath,
      archivedAt: nowIso(),
      archivedBy: actorId,
      components: backup.components.map((component) => ({
        ...component,
        absolutePath: component.relativePath ? path.resolve(archivedBundlePath, component.relativePath) : null,
      })),
    });
    await writeJsonAtomic(path.resolve(archivedBundlePath, MANIFEST_FILENAME), archivedRun);

    logger.info(
      {
        backupId: archivedRun.id,
        bundleName: archivedRun.bundleName,
        bundlePath: archivedRun.bundlePath,
        actorId,
      },
      "Backup archived",
    );
    await appendAuditEvent({
      action: "backup.archived",
      result: "succeeded",
      actorId,
      backupId: archivedRun.id,
      bundleName: archivedRun.bundleName,
      details: {
        archivedPath: archivedBundlePath,
      },
    });

    return backupHistoryActionResultSchema.parse({
      backupId: archivedRun.id,
      bundleName: archivedRun.bundleName,
      action: "archived",
      archivedPath: archivedBundlePath,
    });
  }

  async function unarchiveBackup(backupId: string, actorId: string | null): Promise<BackupHistoryActionResult> {
    if (activeRunPromise) {
      throw conflict("Cannot unarchive a backup while a backup is running.");
    }
    await ensureRestoreIdle("unarchive a backup");

    const settings = await readSettings();
    const backup = await getBackupById(backupId);
    if (backup.status === "running") {
      throw conflict("Cannot unarchive a backup while it is still running.");
    }
    if (!backup.archivedAt) {
      throw conflict("Backup is not archived.");
    }
    if (!(await pathExists(backup.bundlePath))) {
      throw notFound(`Backup bundle '${backup.bundleName}' is missing from disk.`);
    }

    const activeBundlePath = path.resolve(settings.directory, backup.bundleName);
    if (await pathExists(activeBundlePath)) {
      throw conflict(`Active backup bundle '${backup.bundleName}' already exists.`);
    }

    await rename(backup.bundlePath, activeBundlePath);
    const unarchivedRun = backupRunSchema.parse({
      ...backup,
      bundlePath: activeBundlePath,
      archivedAt: null,
      archivedBy: null,
      components: backup.components.map((component) => ({
        ...component,
        absolutePath: component.relativePath ? path.resolve(activeBundlePath, component.relativePath) : null,
      })),
    });
    await writeManifest(unarchivedRun);
    await appendAuditEvent({
      action: "backup.unarchived",
      result: "succeeded",
      actorId,
      backupId: unarchivedRun.id,
      bundleName: unarchivedRun.bundleName,
      details: {
        bundlePath: activeBundlePath,
      },
    });

    return backupHistoryActionResultSchema.parse({
      backupId: unarchivedRun.id,
      bundleName: unarchivedRun.bundleName,
      action: "unarchived",
      archivedPath: null,
    });
  }

  async function deleteBackup(backupId: string, actorId: string | null): Promise<BackupHistoryActionResult> {
    if (activeRunPromise) {
      throw conflict("Cannot delete a backup while a backup is running.");
    }
    await ensureRestoreIdle("delete a backup");

    const settings = await readSettings();
    const backup = await getBackupById(backupId);
    if (backup.status === "running") {
      throw conflict("Cannot delete a backup while it is still running.");
    }
    if (!(await pathExists(backup.bundlePath))) {
      throw notFound(`Backup bundle '${backup.bundleName}' is missing from disk.`);
    }

    await deleteRemoteCopies(backup, settings);
    await rm(backup.bundlePath, { recursive: true, force: true });
    logger.info(
      {
        backupId: backup.id,
        bundleName: backup.bundleName,
        bundlePath: backup.bundlePath,
        actorId,
      },
      "Backup deleted",
    );
    await appendAuditEvent({
      action: "backup.deleted",
      result: "succeeded",
      actorId,
      backupId: backup.id,
      bundleName: backup.bundleName,
      details: {
        deletedRemoteCopies: settings.remote.s3.deleteFromRemoteOnDelete ? backup.remoteCopies.length : 0,
      },
    });

    return backupHistoryActionResultSchema.parse({
      backupId: backup.id,
      bundleName: backup.bundleName,
      action: "deleted",
      archivedPath: null,
    });
  }

  async function getDownloadDescriptor(backupId: string, actorId: string | null): Promise<BackupDownloadDescriptor> {
    const backup = await getBackupById(backupId);
    if (backup.status === "running") {
      throw conflict("Cannot download a backup while it is still running.");
    }
    if (!(await pathExists(backup.bundlePath))) {
      throw notFound(`Backup bundle '${backup.bundleName}' is missing from disk.`);
    }
    await appendAuditEvent({
      action: "backup.downloaded",
      result: "info",
      actorId,
      backupId: backup.id,
      bundleName: backup.bundleName,
      details: {
        archived: Boolean(backup.archivedAt),
        signed: Boolean(backup.signature),
        remoteCopies: backup.remoteCopies.length,
      },
    });
    return {
      backup,
      bundleName: backup.bundleName,
      bundlePath: backup.bundlePath,
      bundleDirectory: path.dirname(backup.bundlePath),
      archiveName: `${backup.bundleName}.tar.gz`,
    };
  }

  async function restoreBackup(backupId: string, actorId: string | null): Promise<BackupRestoreState> {
    if (activeRunPromise) {
      throw conflict("Cannot restore a backup while a backup is running.");
    }
    await ensureRestoreIdle("start a restore");

    const backup = await getBackupById(backupId);
    if (backup.status !== "succeeded") {
      throw conflict("Only successful backups can be restored.");
    }

    try {
      await runRestorePreflight(backup);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await writeRestorePreflightFailure(backup, errorMessage);
      await appendAuditEvent({
        action: "backup.restore.preflight",
        result: "blocked",
        actorId,
        backupId: backup.id,
        bundleName: backup.bundleName,
        details: {
          error: errorMessage,
        },
      });
      throw unprocessable(errorMessage);
    }

    await appendAuditEvent({
      action: "backup.restore.preflight",
      result: "succeeded",
      actorId,
      backupId: backup.id,
      bundleName: backup.bundleName,
      details: null,
    });

    return runRestore(backup, actorId);
  }

  async function tick(now: Date = new Date()): Promise<BackupRun | null> {
    const settings = await readSettings();
    if (!settings.enabled) return null;
    if (activeRunPromise || activeRestorePromise) return null;

    const restoreState = await readRestoreState();
    if (restoreState.status === "running") return null;

    const nextDueAt = lastAutomaticRunAt
      ? new Date(new Date(lastAutomaticRunAt).getTime() + settings.intervalMinutes * 60_000)
      : new Date(schedulerAnchorAt.getTime() + settings.intervalMinutes * 60_000);
    if (now.getTime() < nextDueAt.getTime()) return null;

    schedulerAnchorAt = now;
    try {
      return await startBackup("scheduler", null);
    } catch {
      return null;
    }
  }

  return {
    getOverview,
    updateSettings,
    createManualBackup,
    importBackupArchive,
    previewRestore,
    archiveBackup,
    unarchiveBackup,
    deleteBackup,
    getBackupById,
    getDownloadDescriptor,
    restoreBackup,
    isRestoreRunning: () => activeRestorePromise !== null,
    isSnapshotBarrierActive: () => snapshotBarrierActive,
    tick,
  };
}
