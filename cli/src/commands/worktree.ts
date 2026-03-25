import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  agents,
  assets,
  companies,
  createDb,
  documentRevisions,
  documents,
  ensurePostgresDatabase,
  formatDatabaseBackupResult,
  goals,
  heartbeatRuns,
  inspectMigrations,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  projectWorkspaces,
  projects,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import type { Command } from "commander";
import { ensureAgentJwtSecret, loadPaperclipEnvFile, mergePaperclipEnvEntries, readPaperclipEnvEntries, resolvePaperclipEnvFile } from "../config/env.js";
import { expandHomePrefix } from "../config/home.js";
import type { PaperclipConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";
import {
  buildWorktreeConfig,
  buildWorktreeEnvEntries,
  DEFAULT_WORKTREE_HOME,
  formatShellExports,
  generateWorktreeColor,
  isWorktreeSeedMode,
  resolveSuggestedWorktreeName,
  resolveWorktreeSeedPlan,
  resolveWorktreeLocalPaths,
  sanitizeWorktreeInstanceId,
  type WorktreeSeedMode,
  type WorktreeLocalPaths,
} from "./worktree-lib.js";
import {
  buildWorktreeMergePlan,
  parseWorktreeMergeScopes,
  type IssueAttachmentRow,
  type IssueDocumentRow,
  type DocumentRevisionRow,
  type PlannedAttachmentInsert,
  type PlannedCommentInsert,
  type PlannedIssueDocumentInsert,
  type PlannedIssueDocumentMerge,
  type PlannedIssueInsert,
} from "./worktree-merge-history-lib.js";

type WorktreeInitOptions = {
  name?: string;
  instance?: string;
  home?: string;
  fromConfig?: string;
  fromDataDir?: string;
  fromInstance?: string;
  sourceConfigPathOverride?: string;
  serverPort?: number;
  dbPort?: number;
  seed?: boolean;
  seedMode?: string;
  force?: boolean;
};

type WorktreeMakeOptions = WorktreeInitOptions & {
  startPoint?: string;
};

type WorktreeEnvOptions = {
  config?: string;
  json?: boolean;
};

type WorktreeListOptions = {
  json?: boolean;
};

type WorktreeMergeHistoryOptions = {
  from?: string;
  to?: string;
  company?: string;
  scope?: string;
  apply?: boolean;
  dry?: boolean;
  yes?: boolean;
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

type EmbeddedPostgresHandle = {
  port: number;
  startedByThisProcess: boolean;
  stop: () => Promise<void>;
};

type GitWorkspaceInfo = {
  root: string;
  commonDir: string;
  gitDir: string;
  hooksPath: string;
};

type CopiedGitHooksResult = {
  sourceHooksPath: string;
  targetHooksPath: string;
  copied: boolean;
};

type SeedWorktreeDatabaseResult = {
  backupSummary: string;
  reboundWorkspaces: Array<{
    name: string;
    fromCwd: string;
    toCwd: string;
  }>;
};

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isCurrentSourceConfigPath(sourceConfigPath: string): boolean {
  const currentConfigPath = process.env.PAPERCLIP_CONFIG;
  if (!currentConfigPath || currentConfigPath.trim().length === 0) {
    return false;
  }
  return path.resolve(currentConfigPath) === path.resolve(sourceConfigPath);
}

const WORKTREE_NAME_PREFIX = "paperclip-";

function resolveWorktreeMakeName(name: string): string {
  const value = nonEmpty(name);
  if (!value) {
    throw new Error("Worktree name is required.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      "Worktree name must contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
  return value.startsWith(WORKTREE_NAME_PREFIX) ? value : `${WORKTREE_NAME_PREFIX}${value}`;
}

function resolveWorktreeHome(explicit?: string): string {
  return explicit ?? process.env.PAPERCLIP_WORKTREES_DIR ?? DEFAULT_WORKTREE_HOME;
}

function resolveWorktreeStartPoint(explicit?: string): string | undefined {
  return explicit ?? nonEmpty(process.env.PAPERCLIP_WORKTREE_START_POINT) ?? undefined;
}

type ConfiguredStorage = {
  getObject(companyId: string, objectKey: string): Promise<Buffer>;
  putObject(companyId: string, objectKey: string, body: Buffer, contentType: string): Promise<void>;
};

function assertStorageCompanyPrefix(companyId: string, objectKey: string): void {
  if (!objectKey.startsWith(`${companyId}/`) || objectKey.includes("..")) {
    throw new Error(`Invalid object key for company ${companyId}.`);
  }
}

function normalizeStorageObjectKey(objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw new Error("Invalid object key.");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid object key.");
  }
  return parts.join("/");
}

function resolveLocalStoragePath(baseDir: string, objectKey: string): string {
  const resolved = path.resolve(baseDir, normalizeStorageObjectKey(objectKey));
  const root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid object key path.");
  }
  return resolved;
}

async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error("Object not found.");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Readable) {
    return await streamToBuffer(body);
  }

  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  if (typeof candidate.arrayBuffer === "function") {
    return Buffer.from(await candidate.arrayBuffer());
  }

  throw new Error("Unsupported storage response body.");
}

function normalizeS3Prefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function buildS3ObjectKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;

function createConfiguredStorageFromPaperclipConfig(config: PaperclipConfig): ConfiguredStorage {
  if (config.storage.provider === "local_disk") {
    const baseDir = expandHomePrefix(config.storage.localDisk.baseDir);
    return {
      async getObject(companyId: string, objectKey: string) {
        assertStorageCompanyPrefix(companyId, objectKey);
        return await fsPromises.readFile(resolveLocalStoragePath(baseDir, objectKey));
      },
      async putObject(companyId: string, objectKey: string, body: Buffer) {
        assertStorageCompanyPrefix(companyId, objectKey);
        const filePath = resolveLocalStoragePath(baseDir, objectKey);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, body);
      },
    };
  }

  const prefix = normalizeS3Prefix(config.storage.s3.prefix);
  let s3ClientPromise: Promise<any> | null = null;
  async function getS3Client() {
    if (!s3ClientPromise) {
      s3ClientPromise = (async () => {
        const sdk = await dynamicImport("@aws-sdk/client-s3");
        return {
          sdk,
          client: new sdk.S3Client({
            region: config.storage.s3.region,
            endpoint: config.storage.s3.endpoint,
            forcePathStyle: config.storage.s3.forcePathStyle,
          }),
        };
      })();
    }
    return await s3ClientPromise;
  }
  const bucket = config.storage.s3.bucket;
  return {
    async getObject(companyId: string, objectKey: string) {
      assertStorageCompanyPrefix(companyId, objectKey);
      const { sdk, client } = await getS3Client();
      const response = await client.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
        }),
      );
      return await s3BodyToBuffer(response.Body);
    },
    async putObject(companyId: string, objectKey: string, body: Buffer, contentType: string) {
      assertStorageCompanyPrefix(companyId, objectKey);
      const { sdk, client } = await getS3Client();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
    },
  };
}

function openConfiguredStorage(configPath: string): ConfiguredStorage {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }
  return createConfiguredStorageFromPaperclipConfig(config);
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function isMissingStorageObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  return candidate.code === "ENOENT"
    || candidate.status === 404
    || candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.message === "Object not found.";
}

export async function readSourceAttachmentBody(
  sourceStorages: Array<Pick<ConfiguredStorage, "getObject">>,
  companyId: string,
  objectKey: string,
): Promise<Buffer | null> {
  for (const sourceStorage of sourceStorages) {
    try {
      return await sourceStorage.getObject(companyId, objectKey);
    } catch (error) {
      if (isMissingStorageObjectError(error)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function resolveWorktreeMakeTargetPath(name: string): string {
  return path.resolve(os.homedir(), resolveWorktreeMakeName(name));
}

function extractExecSyncErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : null;
  }

  const stderr = "stderr" in error ? error.stderr : null;
  if (typeof stderr === "string") {
    return nonEmpty(stderr);
  }
  if (stderr instanceof Buffer) {
    return nonEmpty(stderr.toString("utf8"));
  }

  return error instanceof Error ? nonEmpty(error.message) : null;
}

function localBranchExists(cwd: string, branchName: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveGitWorktreeAddArgs(input: {
  branchName: string;
  targetPath: string;
  branchExists: boolean;
  startPoint?: string;
}): string[] {
  if (input.branchExists && !input.startPoint) {
    return ["worktree", "add", input.targetPath, input.branchName];
  }
  const commitish = input.startPoint ?? "HEAD";
  return ["worktree", "add", "-b", input.branchName, input.targetPath, commitish];
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

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(preferredPort: number, reserved = new Set<number>()): Promise<number> {
  let port = Math.max(1, Math.trunc(preferredPort));
  while (reserved.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }
  return port;
}

function detectGitBranchName(cwd: string): string | null {
  try {
    const value = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return nonEmpty(value);
  } catch {
    return null;
  }
}

function detectGitWorkspaceInfo(cwd: string): GitWorkspaceInfo | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const gitDirRaw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const hooksPathRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      root: path.resolve(root),
      commonDir: path.resolve(root, commonDirRaw),
      gitDir: path.resolve(root, gitDirRaw),
      hooksPath: path.resolve(root, hooksPathRaw),
    };
  } catch {
    return null;
  }
}

function copyDirectoryContents(sourceDir: string, targetDir: string): boolean {
  if (!existsSync(sourceDir)) return false;

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) return false;

  mkdirSync(targetDir, { recursive: true });

  let copied = false;
  for (const entry of entries) {
    const sourcePath = path.resolve(sourceDir, entry.name);
    const targetPath = path.resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyDirectoryContents(sourcePath, targetPath);
      copied = true;
      continue;
    }

    if (entry.isSymbolicLink()) {
      rmSync(targetPath, { recursive: true, force: true });
      symlinkSync(readlinkSync(sourcePath), targetPath);
      copied = true;
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    try {
      chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
    } catch {
      // best effort
    }
    copied = true;
  }

  return copied;
}

export function copyGitHooksToWorktreeGitDir(cwd: string): CopiedGitHooksResult | null {
  const workspace = detectGitWorkspaceInfo(cwd);
  if (!workspace) return null;

  const sourceHooksPath = workspace.hooksPath;
  const targetHooksPath = path.resolve(workspace.gitDir, "hooks");

  if (sourceHooksPath === targetHooksPath) {
    return {
      sourceHooksPath,
      targetHooksPath,
      copied: false,
    };
  }

  return {
    sourceHooksPath,
    targetHooksPath,
    copied: copyDirectoryContents(sourceHooksPath, targetHooksPath),
  };
}

export function rebindWorkspaceCwd(input: {
  sourceRepoRoot: string;
  targetRepoRoot: string;
  workspaceCwd: string;
}): string | null {
  const sourceRepoRoot = path.resolve(input.sourceRepoRoot);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);
  const workspaceCwd = path.resolve(input.workspaceCwd);
  const relative = path.relative(sourceRepoRoot, workspaceCwd);
  if (!relative || relative === "") {
    return targetRepoRoot;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return path.resolve(targetRepoRoot, relative);
}

async function rebindSeededProjectWorkspaces(input: {
  targetConnectionString: string;
  currentCwd: string;
}): Promise<SeedWorktreeDatabaseResult["reboundWorkspaces"]> {
  const targetRepo = detectGitWorkspaceInfo(input.currentCwd);
  if (!targetRepo) return [];

  const db = createDb(input.targetConnectionString);
  const closableDb = db as typeof db & {
    $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
  };

  try {
    const rows = await db
      .select({
        id: projectWorkspaces.id,
        name: projectWorkspaces.name,
        cwd: projectWorkspaces.cwd,
      })
      .from(projectWorkspaces);

    const rebound: SeedWorktreeDatabaseResult["reboundWorkspaces"] = [];
    for (const row of rows) {
      const workspaceCwd = nonEmpty(row.cwd);
      if (!workspaceCwd) continue;

      const sourceRepo = detectGitWorkspaceInfo(workspaceCwd);
      if (!sourceRepo) continue;
      if (sourceRepo.commonDir !== targetRepo.commonDir) continue;

      const reboundCwd = rebindWorkspaceCwd({
        sourceRepoRoot: sourceRepo.root,
        targetRepoRoot: targetRepo.root,
        workspaceCwd,
      });
      if (!reboundCwd) continue;

      const normalizedCurrent = path.resolve(workspaceCwd);
      if (reboundCwd === normalizedCurrent) continue;
      if (!existsSync(reboundCwd)) continue;

      await db
        .update(projectWorkspaces)
        .set({
          cwd: reboundCwd,
          updatedAt: new Date(),
        })
        .where(eq(projectWorkspaces.id, row.id));

      rebound.push({
        name: row.name,
        fromCwd: normalizedCurrent,
        toCwd: reboundCwd,
      });
    }

    return rebound;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

export function resolveSourceConfigPath(opts: WorktreeInitOptions): string {
  if (opts.sourceConfigPathOverride) return path.resolve(opts.sourceConfigPathOverride);
  if (opts.fromConfig) return path.resolve(opts.fromConfig);
  if (!opts.fromDataDir && !opts.fromInstance) {
    return resolveConfigPath();
  }
  const sourceHome = path.resolve(expandHomePrefix(opts.fromDataDir ?? "~/.paperclip"));
  const sourceInstanceId = sanitizeWorktreeInstanceId(opts.fromInstance ?? "default");
  return path.resolve(sourceHome, "instances", sourceInstanceId, "config.json");
}

function resolveSourceConnectionString(config: PaperclipConfig, envEntries: Record<string, string>, portOverride?: number): string {
  if (config.database.mode === "postgres") {
    const connectionString = nonEmpty(envEntries.DATABASE_URL) ?? nonEmpty(config.database.connectionString);
    if (!connectionString) {
      throw new Error(
        "Source instance uses postgres mode but has no connection string in config or adjacent .env.",
      );
    }
    return connectionString;
  }

  const port = portOverride ?? config.database.embeddedPostgresPort;
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

export function copySeededSecretsKey(input: {
  sourceConfigPath: string;
  sourceConfig: PaperclipConfig;
  sourceEnvEntries: Record<string, string>;
  targetKeyFilePath: string;
}): void {
  if (input.sourceConfig.secrets.provider !== "local_encrypted") {
    return;
  }

  mkdirSync(path.dirname(input.targetKeyFilePath), { recursive: true });

  const allowProcessEnvFallback = isCurrentSourceConfigPath(input.sourceConfigPath);
  const sourceInlineMasterKey =
    nonEmpty(input.sourceEnvEntries.PAPERCLIP_SECRETS_MASTER_KEY) ??
    (allowProcessEnvFallback ? nonEmpty(process.env.PAPERCLIP_SECRETS_MASTER_KEY) : null);
  if (sourceInlineMasterKey) {
    writeFileSync(input.targetKeyFilePath, sourceInlineMasterKey, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(input.targetKeyFilePath, 0o600);
    } catch {
      // best effort
    }
    return;
  }

  const sourceKeyFileOverride =
    nonEmpty(input.sourceEnvEntries.PAPERCLIP_SECRETS_MASTER_KEY_FILE) ??
    (allowProcessEnvFallback ? nonEmpty(process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE) : null);
  const sourceConfiguredKeyPath = sourceKeyFileOverride ?? input.sourceConfig.secrets.localEncrypted.keyFilePath;
  const sourceKeyFilePath = resolveRuntimeLikePath(sourceConfiguredKeyPath, input.sourceConfigPath);

  if (!existsSync(sourceKeyFilePath)) {
    throw new Error(
      `Cannot seed worktree database because source local_encrypted secrets key was not found at ${sourceKeyFilePath}.`,
    );
  }

  copyFileSync(sourceKeyFilePath, input.targetKeyFilePath);
  try {
    chmodSync(input.targetKeyFilePath, 0o600);
  } catch {
    // best effort
  }
}

async function ensureEmbeddedPostgres(dataDir: string, preferredPort: number): Promise<EmbeddedPostgresHandle> {
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

  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  if (runningPid) {
    return {
      port: readPidFilePort(postmasterPidFile) ?? preferredPort,
      startedByThisProcess: false,
      stop: async () => {},
    };
  }

  const port = await findAvailablePort(preferredPort);
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    await instance.initialise();
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  await instance.start();

  return {
    port,
    startedByThisProcess: true,
    stop: async () => {
      await instance.stop();
    },
  };
}

async function seedWorktreeDatabase(input: {
  sourceConfigPath: string;
  sourceConfig: PaperclipConfig;
  targetConfig: PaperclipConfig;
  targetPaths: WorktreeLocalPaths;
  instanceId: string;
  seedMode: WorktreeSeedMode;
}): Promise<SeedWorktreeDatabaseResult> {
  const seedPlan = resolveWorktreeSeedPlan(input.seedMode);
  const sourceEnvFile = resolvePaperclipEnvFile(input.sourceConfigPath);
  const sourceEnvEntries = readPaperclipEnvEntries(sourceEnvFile);
  copySeededSecretsKey({
    sourceConfigPath: input.sourceConfigPath,
    sourceConfig: input.sourceConfig,
    sourceEnvEntries,
    targetKeyFilePath: input.targetPaths.secretsKeyFilePath,
  });
  let sourceHandle: EmbeddedPostgresHandle | null = null;
  let targetHandle: EmbeddedPostgresHandle | null = null;

  try {
    if (input.sourceConfig.database.mode === "embedded-postgres") {
      sourceHandle = await ensureEmbeddedPostgres(
        input.sourceConfig.database.embeddedPostgresDataDir,
        input.sourceConfig.database.embeddedPostgresPort,
      );
    }
    const sourceConnectionString = resolveSourceConnectionString(
      input.sourceConfig,
      sourceEnvEntries,
      sourceHandle?.port,
    );
    const backup = await runDatabaseBackup({
      connectionString: sourceConnectionString,
      backupDir: path.resolve(input.targetPaths.backupDir, "seed"),
      retentionDays: 7,
      filenamePrefix: `${input.instanceId}-seed`,
      includeMigrationJournal: true,
      excludeTables: seedPlan.excludedTables,
      nullifyColumns: seedPlan.nullifyColumns,
    });

    targetHandle = await ensureEmbeddedPostgres(
      input.targetConfig.database.embeddedPostgresDataDir,
      input.targetConfig.database.embeddedPostgresPort,
    );

    const adminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${targetHandle.port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "paperclip");
    const targetConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${targetHandle.port}/paperclip`;
    await runDatabaseRestore({
      connectionString: targetConnectionString,
      backupFile: backup.backupFile,
    });
    await applyPendingMigrations(targetConnectionString);
    const reboundWorkspaces = await rebindSeededProjectWorkspaces({
      targetConnectionString,
      currentCwd: input.targetPaths.cwd,
    });

    return {
      backupSummary: formatDatabaseBackupResult(backup),
      reboundWorkspaces,
    };
  } finally {
    if (targetHandle?.startedByThisProcess) {
      await targetHandle.stop();
    }
    if (sourceHandle?.startedByThisProcess) {
      await sourceHandle.stop();
    }
  }
}

async function runWorktreeInit(opts: WorktreeInitOptions): Promise<void> {
  const cwd = process.cwd();
  const worktreeName = resolveSuggestedWorktreeName(
    cwd,
    opts.name ?? detectGitBranchName(cwd) ?? undefined,
  );
  const seedMode = opts.seedMode ?? "minimal";
  if (!isWorktreeSeedMode(seedMode)) {
    throw new Error(`Unsupported seed mode "${seedMode}". Expected one of: minimal, full.`);
  }
  const instanceId = sanitizeWorktreeInstanceId(opts.instance ?? worktreeName);
  const paths = resolveWorktreeLocalPaths({
    cwd,
    homeDir: resolveWorktreeHome(opts.home),
    instanceId,
  });
  const branding = {
    name: worktreeName,
    color: generateWorktreeColor(),
  };
  const sourceConfigPath = resolveSourceConfigPath(opts);
  const sourceConfig = existsSync(sourceConfigPath) ? readConfig(sourceConfigPath) : null;

  if ((existsSync(paths.configPath) || existsSync(paths.instanceRoot)) && !opts.force) {
    throw new Error(
      `Worktree config already exists at ${paths.configPath} or instance data exists at ${paths.instanceRoot}. Re-run with --force to replace it.`,
    );
  }

  if (opts.force) {
    rmSync(paths.repoConfigDir, { recursive: true, force: true });
    rmSync(paths.instanceRoot, { recursive: true, force: true });
  }

  const preferredServerPort = opts.serverPort ?? ((sourceConfig?.server.port ?? 3100) + 1);
  const serverPort = await findAvailablePort(preferredServerPort);
  const preferredDbPort = opts.dbPort ?? ((sourceConfig?.database.embeddedPostgresPort ?? 54329) + 1);
  const databasePort = await findAvailablePort(preferredDbPort, new Set([serverPort]));
  const targetConfig = buildWorktreeConfig({
    sourceConfig,
    paths,
    serverPort,
    databasePort,
  });

  writeConfig(targetConfig, paths.configPath);
  const sourceEnvEntries = readPaperclipEnvEntries(resolvePaperclipEnvFile(sourceConfigPath));
  const existingAgentJwtSecret =
    nonEmpty(sourceEnvEntries.PAPERCLIP_AGENT_JWT_SECRET) ??
    nonEmpty(process.env.PAPERCLIP_AGENT_JWT_SECRET);
  mergePaperclipEnvEntries(
    {
      ...buildWorktreeEnvEntries(paths, branding),
      ...(existingAgentJwtSecret ? { PAPERCLIP_AGENT_JWT_SECRET: existingAgentJwtSecret } : {}),
    },
    paths.envPath,
  );
  ensureAgentJwtSecret(paths.configPath);
  loadPaperclipEnvFile(paths.configPath);
  const copiedGitHooks = copyGitHooksToWorktreeGitDir(cwd);

  let seedSummary: string | null = null;
  let reboundWorkspaceSummary: SeedWorktreeDatabaseResult["reboundWorkspaces"] = [];
  if (opts.seed !== false) {
    if (!sourceConfig) {
      throw new Error(
        `Cannot seed worktree database because source config was not found at ${sourceConfigPath}. Use --no-seed or provide --from-config.`,
      );
    }
    const spinner = p.spinner();
    spinner.start(`Seeding isolated worktree database from source instance (${seedMode})...`);
    try {
      const seeded = await seedWorktreeDatabase({
        sourceConfigPath,
        sourceConfig,
        targetConfig,
        targetPaths: paths,
        instanceId,
        seedMode,
      });
      seedSummary = seeded.backupSummary;
      reboundWorkspaceSummary = seeded.reboundWorkspaces;
      spinner.stop(`Seeded isolated worktree database (${seedMode}).`);
    } catch (error) {
      spinner.stop(pc.red("Failed to seed worktree database."));
      throw error;
    }
  }

  p.log.message(pc.dim(`Repo config: ${paths.configPath}`));
  p.log.message(pc.dim(`Repo env: ${paths.envPath}`));
  p.log.message(pc.dim(`Isolated home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Worktree badge: ${branding.name} (${branding.color})`));
  p.log.message(pc.dim(`Server port: ${serverPort} | DB port: ${databasePort}`));
  if (copiedGitHooks?.copied) {
    p.log.message(
      pc.dim(`Mirrored git hooks: ${copiedGitHooks.sourceHooksPath} -> ${copiedGitHooks.targetHooksPath}`),
    );
  }
  if (seedSummary) {
    p.log.message(pc.dim(`Seed mode: ${seedMode}`));
    p.log.message(pc.dim(`Seed snapshot: ${seedSummary}`));
    for (const rebound of reboundWorkspaceSummary) {
      p.log.message(
        pc.dim(`Rebound workspace ${rebound.name}: ${rebound.fromCwd} -> ${rebound.toCwd}`),
      );
    }
  }
  p.outro(
    pc.green(
      `Worktree ready. Run Paperclip inside this repo and the CLI/server will use ${paths.instanceId} automatically.`,
    ),
  );
}

export async function worktreeInitCommand(opts: WorktreeInitOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai worktree init ")));
  await runWorktreeInit(opts);
}

export async function worktreeMakeCommand(nameArg: string, opts: WorktreeMakeOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai worktree:make ")));

  const name = resolveWorktreeMakeName(nameArg);
  const startPoint = resolveWorktreeStartPoint(opts.startPoint);
  const sourceCwd = process.cwd();
  const sourceConfigPath = resolveSourceConfigPath(opts);
  const targetPath = resolveWorktreeMakeTargetPath(name);
  if (existsSync(targetPath)) {
    throw new Error(`Target path already exists: ${targetPath}`);
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (startPoint) {
    const [remote] = startPoint.split("/", 1);
    try {
      execFileSync("git", ["fetch", remote], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch from remote "${remote}": ${extractExecSyncErrorMessage(error) ?? String(error)}`,
      );
    }
  }

  const worktreeArgs = resolveGitWorktreeAddArgs({
    branchName: name,
    targetPath,
    branchExists: !startPoint && localBranchExists(sourceCwd, name),
    startPoint,
  });

  const spinner = p.spinner();
  spinner.start(`Creating git worktree at ${targetPath}...`);
  try {
    execFileSync("git", worktreeArgs, {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spinner.stop(`Created git worktree at ${targetPath}.`);
  } catch (error) {
    spinner.stop(pc.red("Failed to create git worktree."));
    throw new Error(extractExecSyncErrorMessage(error) ?? String(error));
  }

  const installSpinner = p.spinner();
  installSpinner.start("Installing dependencies...");
  try {
    execFileSync("pnpm", ["install"], {
      cwd: targetPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    installSpinner.stop("Installed dependencies.");
  } catch (error) {
    installSpinner.stop(pc.yellow("Failed to install dependencies (continuing anyway)."));
    p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
  }

  const originalCwd = process.cwd();
  try {
    process.chdir(targetPath);
    await runWorktreeInit({
      ...opts,
      name,
      sourceConfigPathOverride: sourceConfigPath,
    });
  } catch (error) {
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
}

type WorktreeCleanupOptions = {
  instance?: string;
  home?: string;
  force?: boolean;
};

type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

type MergeSourceChoice = {
  worktree: string;
  branch: string | null;
  branchLabel: string;
  hasPaperclipConfig: boolean;
  isCurrent: boolean;
};

type ResolvedWorktreeEndpoint = {
  rootPath: string;
  configPath: string;
  label: string;
  isCurrent: boolean;
};

function parseGitWorktreeList(cwd: string): GitWorktreeListEntry[] {
  const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
      current = {};
    }
  }
  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
  }
  return entries;
}

function toMergeSourceChoices(cwd: string): MergeSourceChoice[] {
  const currentCwd = path.resolve(cwd);
  return parseGitWorktreeList(cwd).map((entry) => {
    const branchLabel = entry.branch?.replace(/^refs\/heads\//, "") ?? "(detached)";
    const worktreePath = path.resolve(entry.worktree);
    return {
      worktree: worktreePath,
      branch: entry.branch,
      branchLabel,
      hasPaperclipConfig: existsSync(path.resolve(worktreePath, ".paperclip", "config.json")),
      isCurrent: worktreePath === currentCwd,
    };
  });
}

function branchHasUniqueCommits(cwd: string, branchName: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["log", "--oneline", branchName, "--not", "--remotes", "--exclude", `refs/heads/${branchName}`, "--branches"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function branchExistsOnAnyRemote(cwd: string, branchName: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["branch", "-r", "--list", `*/${branchName}`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function worktreePathHasUncommittedChanges(worktreePath: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain"],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export async function worktreeCleanupCommand(nameArg: string, opts: WorktreeCleanupOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclipai worktree:cleanup ")));

  const name = resolveWorktreeMakeName(nameArg);
  const sourceCwd = process.cwd();
  const targetPath = resolveWorktreeMakeTargetPath(name);
  const instanceId = sanitizeWorktreeInstanceId(opts.instance ?? name);
  const homeDir = path.resolve(expandHomePrefix(resolveWorktreeHome(opts.home)));
  const instanceRoot = path.resolve(homeDir, "instances", instanceId);

  // ── 1. Assess current state ──────────────────────────────────────────

  const hasBranch = localBranchExists(sourceCwd, name);
  const hasTargetDir = existsSync(targetPath);
  const hasInstanceData = existsSync(instanceRoot);

  const worktrees = parseGitWorktreeList(sourceCwd);
  const linkedWorktree = worktrees.find(
    (wt) => wt.branch === `refs/heads/${name}` || path.resolve(wt.worktree) === path.resolve(targetPath),
  );

  if (!hasBranch && !hasTargetDir && !hasInstanceData && !linkedWorktree) {
    p.log.info("Nothing to clean up — no branch, worktree directory, or instance data found.");
    p.outro(pc.green("Already clean."));
    return;
  }

  // ── 2. Safety checks ────────────────────────────────────────────────

  const problems: string[] = [];

  if (hasBranch && branchHasUniqueCommits(sourceCwd, name)) {
    const onRemote = branchExistsOnAnyRemote(sourceCwd, name);
    if (onRemote) {
      p.log.info(
        `Branch "${name}" has unique local commits, but the branch also exists on a remote — safe to delete locally.`,
      );
    } else {
      problems.push(
        `Branch "${name}" has commits not found on any other branch or remote. ` +
          `Deleting it will lose work. Push it first, or use --force.`,
      );
    }
  }

  if (hasTargetDir && worktreePathHasUncommittedChanges(targetPath)) {
    problems.push(
      `Worktree directory ${targetPath} has uncommitted changes. Commit or stash first, or use --force.`,
    );
  }

  if (problems.length > 0 && !opts.force) {
    for (const problem of problems) {
      p.log.error(problem);
    }
    throw new Error("Safety checks failed. Resolve the issues above or re-run with --force.");
  }
  if (problems.length > 0 && opts.force) {
    for (const problem of problems) {
      p.log.warning(`Overridden by --force: ${problem}`);
    }
  }

  // ── 3. Clean up (idempotent steps) ──────────────────────────────────

  // 3a. Remove the git worktree registration
  if (linkedWorktree) {
    const worktreeDirExists = existsSync(linkedWorktree.worktree);
    const spinner = p.spinner();
    if (worktreeDirExists) {
      spinner.start(`Removing git worktree at ${linkedWorktree.worktree}...`);
      try {
        const removeArgs = ["worktree", "remove", linkedWorktree.worktree];
        if (opts.force) removeArgs.push("--force");
        execFileSync("git", removeArgs, {
          cwd: sourceCwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        spinner.stop(`Removed git worktree at ${linkedWorktree.worktree}.`);
      } catch (error) {
        spinner.stop(pc.yellow(`Could not remove worktree cleanly, will prune instead.`));
        p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
      }
    } else {
      spinner.start("Pruning stale worktree entry...");
      execFileSync("git", ["worktree", "prune"], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      spinner.stop("Pruned stale worktree entry.");
    }
  } else {
    // Even without a linked worktree, prune to clean up any orphaned entries
    execFileSync("git", ["worktree", "prune"], {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // 3b. Remove the worktree directory if it still exists (e.g. partial creation)
  if (existsSync(targetPath)) {
    const spinner = p.spinner();
    spinner.start(`Removing worktree directory ${targetPath}...`);
    rmSync(targetPath, { recursive: true, force: true });
    spinner.stop(`Removed worktree directory ${targetPath}.`);
  }

  // 3c. Delete the local branch (now safe — worktree is gone)
  if (localBranchExists(sourceCwd, name)) {
    const spinner = p.spinner();
    spinner.start(`Deleting local branch "${name}"...`);
    try {
      const deleteFlag = opts.force ? "-D" : "-d";
      execFileSync("git", ["branch", deleteFlag, name], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      spinner.stop(`Deleted local branch "${name}".`);
    } catch (error) {
      spinner.stop(pc.yellow(`Could not delete branch "${name}".`));
      p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
    }
  }

  // 3d. Remove instance data
  if (existsSync(instanceRoot)) {
    const spinner = p.spinner();
    spinner.start(`Removing instance data at ${instanceRoot}...`);
    rmSync(instanceRoot, { recursive: true, force: true });
    spinner.stop(`Removed instance data at ${instanceRoot}.`);
  }

  p.outro(pc.green("Cleanup complete."));
}

export async function worktreeEnvCommand(opts: WorktreeEnvOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const envPath = resolvePaperclipEnvFile(configPath);
  const envEntries = readPaperclipEnvEntries(envPath);
  const out = {
    PAPERCLIP_CONFIG: configPath,
    ...(envEntries.PAPERCLIP_HOME ? { PAPERCLIP_HOME: envEntries.PAPERCLIP_HOME } : {}),
    ...(envEntries.PAPERCLIP_INSTANCE_ID ? { PAPERCLIP_INSTANCE_ID: envEntries.PAPERCLIP_INSTANCE_ID } : {}),
    ...(envEntries.PAPERCLIP_CONTEXT ? { PAPERCLIP_CONTEXT: envEntries.PAPERCLIP_CONTEXT } : {}),
    ...envEntries,
  };

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(formatShellExports(out));
}

type ClosableDb = ReturnType<typeof createDb> & {
  $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
};

type OpenDbHandle = {
  db: ClosableDb;
  stop: () => Promise<void>;
};

type ResolvedMergeCompany = {
  id: string;
  name: string;
  issuePrefix: string;
};

async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

function resolveCurrentEndpoint(): ResolvedWorktreeEndpoint {
  return {
    rootPath: path.resolve(process.cwd()),
    configPath: resolveConfigPath(),
    label: "current",
    isCurrent: true,
  };
}

function resolveAttachmentLookupStorages(input: {
  sourceEndpoint: ResolvedWorktreeEndpoint;
  targetEndpoint: ResolvedWorktreeEndpoint;
}): ConfiguredStorage[] {
  const orderedConfigPaths = [
    input.sourceEndpoint.configPath,
    resolveCurrentEndpoint().configPath,
    input.targetEndpoint.configPath,
    ...toMergeSourceChoices(process.cwd())
      .filter((choice) => choice.hasPaperclipConfig)
      .map((choice) => path.resolve(choice.worktree, ".paperclip", "config.json")),
  ];
  const seen = new Set<string>();
  const storages: ConfiguredStorage[] = [];
  for (const configPath of orderedConfigPaths) {
    const resolved = path.resolve(configPath);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    storages.push(openConfiguredStorage(resolved));
  }
  return storages;
}

async function openConfiguredDb(configPath: string): Promise<OpenDbHandle> {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }
  const envEntries = readPaperclipEnvEntries(resolvePaperclipEnvFile(configPath));
  let embeddedHandle: EmbeddedPostgresHandle | null = null;

  try {
    if (config.database.mode === "embedded-postgres") {
      embeddedHandle = await ensureEmbeddedPostgres(
        config.database.embeddedPostgresDataDir,
        config.database.embeddedPostgresPort,
      );
    }
    const connectionString = resolveSourceConnectionString(config, envEntries, embeddedHandle?.port);
    const migrationState = await inspectMigrations(connectionString);
    if (migrationState.status !== "upToDate") {
      const pending =
        migrationState.reason === "pending-migrations"
          ? ` Pending migrations: ${migrationState.pendingMigrations.join(", ")}.`
          : "";
      throw new Error(
        `Database for ${configPath} is not up to date.${pending} Run \`pnpm db:migrate\` (or start Paperclip once) before using worktree merge history.`,
      );
    }
    const db = createDb(connectionString) as ClosableDb;
    return {
      db,
      stop: async () => {
        await closeDb(db);
        if (embeddedHandle?.startedByThisProcess) {
          await embeddedHandle.stop();
        }
      },
    };
  } catch (error) {
    if (embeddedHandle?.startedByThisProcess) {
      await embeddedHandle.stop().catch(() => undefined);
    }
    throw error;
  }
}

async function resolveMergeCompany(input: {
  sourceDb: ClosableDb;
  targetDb: ClosableDb;
  selector?: string;
}): Promise<ResolvedMergeCompany> {
  const [sourceCompanies, targetCompanies] = await Promise.all([
    input.sourceDb
      .select({
        id: companies.id,
        name: companies.name,
        issuePrefix: companies.issuePrefix,
      })
      .from(companies),
    input.targetDb
      .select({
        id: companies.id,
        name: companies.name,
        issuePrefix: companies.issuePrefix,
      })
      .from(companies),
  ]);

  const targetById = new Map(targetCompanies.map((company) => [company.id, company]));
  const shared = sourceCompanies.filter((company) => targetById.has(company.id));
  const selector = nonEmpty(input.selector);
  if (selector) {
    const matched = shared.find(
      (company) => company.id === selector || company.issuePrefix.toLowerCase() === selector.toLowerCase(),
    );
    if (!matched) {
      throw new Error(`Could not resolve company "${selector}" in both source and target databases.`);
    }
    return matched;
  }

  if (shared.length === 1) {
    return shared[0];
  }

  if (shared.length === 0) {
    throw new Error("Source and target databases do not share a company id. Pass --company explicitly once both sides match.");
  }

  const options = shared
    .map((company) => `${company.issuePrefix} (${company.name})`)
    .join(", ");
  throw new Error(`Multiple shared companies found. Re-run with --company <id-or-prefix>. Options: ${options}`);
}

function renderMergePlan(plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"], extras: {
  sourcePath: string;
  targetPath: string;
  unsupportedRunCount: number;
}): string {
  const terminalWidth = Math.max(60, process.stdout.columns ?? 100);
  const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
  const truncateToWidth = (value: string, maxWidth: number) => {
    if (maxWidth <= 1) return "";
    if (value.length <= maxWidth) return value;
    return `${value.slice(0, Math.max(0, maxWidth - 1)).trimEnd()}…`;
  };
  const lines = [
    `Mode: preview`,
    `Source: ${extras.sourcePath}`,
    `Target: ${extras.targetPath}`,
    `Company: ${plan.companyName} (${plan.issuePrefix})`,
    "",
    "Projects",
    `- import: ${plan.counts.projectsToImport}`,
    "",
    "Issues",
    `- insert: ${plan.counts.issuesToInsert}`,
    `- already present: ${plan.counts.issuesExisting}`,
    `- shared/imported issues with drift: ${plan.counts.issueDrift}`,
  ];

  if (plan.projectImports.length > 0) {
    lines.push("");
    lines.push("Planned project imports");
    for (const project of plan.projectImports) {
      lines.push(
        `- ${project.source.name} (${project.workspaces.length} workspace${project.workspaces.length === 1 ? "" : "s"})`,
      );
    }
  }

  const issueInserts = plan.issuePlans.filter((item): item is PlannedIssueInsert => item.action === "insert");
  if (issueInserts.length > 0) {
    lines.push("");
    lines.push("Planned issue imports");
    for (const issue of issueInserts) {
      const projectNote =
        (issue.projectResolution === "mapped" || issue.projectResolution === "imported")
        && issue.mappedProjectName
          ? ` project->${issue.projectResolution === "imported" ? "import:" : ""}${issue.mappedProjectName}`
          : "";
      const adjustments = issue.adjustments.length > 0 ? ` [${issue.adjustments.join(", ")}]` : "";
      const prefix = `- ${issue.source.identifier ?? issue.source.id} -> ${issue.previewIdentifier} (${issue.targetStatus}${projectNote})`;
      const title = oneLine(issue.source.title);
      const suffix = `${adjustments}${title ? ` ${title}` : ""}`;
      lines.push(
        `${prefix}${truncateToWidth(suffix, Math.max(8, terminalWidth - prefix.length))}`,
      );
    }
  }

  if (plan.scopes.includes("comments")) {
    lines.push("");
    lines.push("Comments");
    lines.push(`- insert: ${plan.counts.commentsToInsert}`);
    lines.push(`- already present: ${plan.counts.commentsExisting}`);
    lines.push(`- skipped (missing parent): ${plan.counts.commentsMissingParent}`);
  }

  lines.push("");
  lines.push("Documents");
  lines.push(`- insert: ${plan.counts.documentsToInsert}`);
  lines.push(`- merge existing: ${plan.counts.documentsToMerge}`);
  lines.push(`- already present: ${plan.counts.documentsExisting}`);
  lines.push(`- skipped (conflicting key): ${plan.counts.documentsConflictingKey}`);
  lines.push(`- skipped (missing parent): ${plan.counts.documentsMissingParent}`);
  lines.push(`- revisions insert: ${plan.counts.documentRevisionsToInsert}`);

  lines.push("");
  lines.push("Attachments");
  lines.push(`- insert: ${plan.counts.attachmentsToInsert}`);
  lines.push(`- already present: ${plan.counts.attachmentsExisting}`);
  lines.push(`- skipped (missing parent): ${plan.counts.attachmentsMissingParent}`);

  lines.push("");
  lines.push("Adjustments");
  lines.push(`- cleared assignee agents: ${plan.adjustments.clear_assignee_agent}`);
  lines.push(`- cleared projects: ${plan.adjustments.clear_project}`);
  lines.push(`- cleared project workspaces: ${plan.adjustments.clear_project_workspace}`);
  lines.push(`- cleared goals: ${plan.adjustments.clear_goal}`);
  lines.push(`- cleared comment author agents: ${plan.adjustments.clear_author_agent}`);
  lines.push(`- cleared document agents: ${plan.adjustments.clear_document_agent}`);
  lines.push(`- cleared document revision agents: ${plan.adjustments.clear_document_revision_agent}`);
  lines.push(`- cleared attachment author agents: ${plan.adjustments.clear_attachment_agent}`);
  lines.push(`- coerced in_progress to todo: ${plan.adjustments.coerce_in_progress_to_todo}`);

  lines.push("");
  lines.push("Not imported in this phase");
  lines.push(`- heartbeat runs: ${extras.unsupportedRunCount}`);
  lines.push("");
  lines.push("Identifiers shown above are provisional preview values. `--apply` reserves fresh issue numbers at write time.");

  return lines.join("\n");
}

async function collectMergePlan(input: {
  sourceDb: ClosableDb;
  targetDb: ClosableDb;
  company: ResolvedMergeCompany;
  scopes: ReturnType<typeof parseWorktreeMergeScopes>;
  importProjectIds?: Iterable<string>;
  projectIdOverrides?: Record<string, string | null | undefined>;
}) {
  const companyId = input.company.id;
  const [
    targetCompanyRow,
    sourceIssuesRows,
    targetIssuesRows,
    sourceCommentsRows,
    targetCommentsRows,
    sourceIssueDocumentsRows,
    targetIssueDocumentsRows,
    sourceDocumentRevisionRows,
    targetDocumentRevisionRows,
    sourceAttachmentRows,
    targetAttachmentRows,
    sourceProjectsRows,
    sourceProjectWorkspaceRows,
    targetProjectsRows,
    targetAgentsRows,
    targetProjectWorkspaceRows,
    targetGoalsRows,
    runCountRows,
  ] = await Promise.all([
    input.targetDb
      .select({
        issueCounter: companies.issueCounter,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null),
    input.sourceDb
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId)),
    input.targetDb
      .select()
      .from(issues)
      .where(eq(issues.companyId, companyId)),
    input.scopes.includes("comments")
      ? input.sourceDb
        .select()
        .from(issueComments)
        .where(eq(issueComments.companyId, companyId))
      : Promise.resolve([]),
    input.targetDb
      .select()
      .from(issueComments)
      .where(eq(issueComments.companyId, companyId)),
    input.sourceDb
      .select({
        id: issueDocuments.id,
        companyId: issueDocuments.companyId,
        issueId: issueDocuments.issueId,
        documentId: issueDocuments.documentId,
        key: issueDocuments.key,
        linkCreatedAt: issueDocuments.createdAt,
        linkUpdatedAt: issueDocuments.updatedAt,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        documentCreatedAt: documents.createdAt,
        documentUpdatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.targetDb
      .select({
        id: issueDocuments.id,
        companyId: issueDocuments.companyId,
        issueId: issueDocuments.issueId,
        documentId: issueDocuments.documentId,
        key: issueDocuments.key,
        linkCreatedAt: issueDocuments.createdAt,
        linkUpdatedAt: issueDocuments.updatedAt,
        title: documents.title,
        format: documents.format,
        latestBody: documents.latestBody,
        latestRevisionId: documents.latestRevisionId,
        latestRevisionNumber: documents.latestRevisionNumber,
        createdByAgentId: documents.createdByAgentId,
        createdByUserId: documents.createdByUserId,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
        documentCreatedAt: documents.createdAt,
        documentUpdatedAt: documents.updatedAt,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.sourceDb
      .select({
        id: documentRevisions.id,
        companyId: documentRevisions.companyId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        changeSummary: documentRevisions.changeSummary,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.targetDb
      .select({
        id: documentRevisions.id,
        companyId: documentRevisions.companyId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        changeSummary: documentRevisions.changeSummary,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.sourceDb
      .select({
        id: issueAttachments.id,
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        assetId: issueAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        assetCreatedAt: assets.createdAt,
        assetUpdatedAt: assets.updatedAt,
        attachmentCreatedAt: issueAttachments.createdAt,
        attachmentUpdatedAt: issueAttachments.updatedAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.targetDb
      .select({
        id: issueAttachments.id,
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        issueCommentId: issueAttachments.issueCommentId,
        assetId: issueAttachments.assetId,
        provider: assets.provider,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
        assetCreatedAt: assets.createdAt,
        assetUpdatedAt: assets.updatedAt,
        attachmentCreatedAt: issueAttachments.createdAt,
        attachmentUpdatedAt: issueAttachments.updatedAt,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .innerJoin(issues, eq(issueAttachments.issueId, issues.id))
      .where(eq(issues.companyId, companyId)),
    input.sourceDb
      .select()
      .from(projects)
      .where(eq(projects.companyId, companyId)),
    input.sourceDb
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId)),
    input.targetDb
      .select()
      .from(projects)
      .where(eq(projects.companyId, companyId)),
    input.targetDb
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId)),
    input.targetDb
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId)),
    input.targetDb
      .select()
      .from(goals)
      .where(eq(goals.companyId, companyId)),
    input.sourceDb
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId)),
  ]);

  if (!targetCompanyRow) {
    throw new Error(`Target company ${companyId} was not found.`);
  }

  const plan = buildWorktreeMergePlan({
    companyId,
    companyName: input.company.name,
    issuePrefix: input.company.issuePrefix,
    previewIssueCounterStart: targetCompanyRow.issueCounter,
    scopes: input.scopes,
    sourceIssues: sourceIssuesRows,
    targetIssues: targetIssuesRows,
    sourceComments: sourceCommentsRows,
    targetComments: targetCommentsRows,
    sourceProjects: sourceProjectsRows,
    sourceProjectWorkspaces: sourceProjectWorkspaceRows,
    sourceDocuments: sourceIssueDocumentsRows as IssueDocumentRow[],
    targetDocuments: targetIssueDocumentsRows as IssueDocumentRow[],
    sourceDocumentRevisions: sourceDocumentRevisionRows as DocumentRevisionRow[],
    targetDocumentRevisions: targetDocumentRevisionRows as DocumentRevisionRow[],
    sourceAttachments: sourceAttachmentRows as IssueAttachmentRow[],
    targetAttachments: targetAttachmentRows as IssueAttachmentRow[],
    targetAgents: targetAgentsRows,
    targetProjects: targetProjectsRows,
    targetProjectWorkspaces: targetProjectWorkspaceRows,
    targetGoals: targetGoalsRows,
    importProjectIds: input.importProjectIds,
    projectIdOverrides: input.projectIdOverrides,
  });

  return {
    plan,
    sourceProjects: sourceProjectsRows,
    targetProjects: targetProjectsRows,
    unsupportedRunCount: runCountRows[0]?.count ?? 0,
  };
}

type ProjectMappingSelections = {
  importProjectIds: string[];
  projectIdOverrides: Record<string, string | null>;
};

async function promptForProjectMappings(input: {
  plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"];
  sourceProjects: Awaited<ReturnType<typeof collectMergePlan>>["sourceProjects"];
  targetProjects: Awaited<ReturnType<typeof collectMergePlan>>["targetProjects"];
}): Promise<ProjectMappingSelections> {
  const missingProjectIds = [
    ...new Set(
      input.plan.issuePlans
        .filter((plan): plan is PlannedIssueInsert => plan.action === "insert")
        .filter((plan) => !!plan.source.projectId && plan.projectResolution === "cleared")
        .map((plan) => plan.source.projectId as string),
    ),
  ];
  if (missingProjectIds.length === 0) {
    return {
      importProjectIds: [],
      projectIdOverrides: {},
    };
  }

  const sourceProjectsById = new Map(input.sourceProjects.map((project) => [project.id, project]));
  const targetChoices = [...input.targetProjects]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      value: project.id,
      label: project.name,
      hint: project.status,
    }));

  const mappings: Record<string, string | null> = {};
  const importProjectIds = new Set<string>();
  for (const sourceProjectId of missingProjectIds) {
    const sourceProject = sourceProjectsById.get(sourceProjectId);
    if (!sourceProject) continue;
    const nameMatch = input.targetProjects.find(
      (project) => project.name.trim().toLowerCase() === sourceProject.name.trim().toLowerCase(),
    );
    const importSelectionValue = `__import__:${sourceProjectId}`;
    const selection = await p.select<string | null>({
      message: `Project "${sourceProject.name}" is missing in target. How should ${input.plan.issuePrefix} imports handle it?`,
      options: [
        {
          value: importSelectionValue,
          label: `Import ${sourceProject.name}`,
          hint: "Create the project and copy its workspace settings",
        },
        ...(nameMatch
          ? [{
              value: nameMatch.id,
              label: `Map to ${nameMatch.name}`,
              hint: "Recommended: exact name match",
            }]
          : []),
        {
          value: null,
          label: "Leave unset",
          hint: "Keep imported issues without a project",
        },
        ...targetChoices.filter((choice) => choice.value !== nameMatch?.id),
      ],
      initialValue: nameMatch?.id ?? null,
    });
    if (p.isCancel(selection)) {
      throw new Error("Project mapping cancelled.");
    }
    if (selection === importSelectionValue) {
      importProjectIds.add(sourceProjectId);
      continue;
    }
    mappings[sourceProjectId] = selection;
  }

  return {
    importProjectIds: [...importProjectIds],
    projectIdOverrides: mappings,
  };
}

export async function worktreeListCommand(opts: WorktreeListOptions): Promise<void> {
  const choices = toMergeSourceChoices(process.cwd());
  if (opts.json) {
    console.log(JSON.stringify(choices, null, 2));
    return;
  }

  for (const choice of choices) {
    const flags = [
      choice.isCurrent ? "current" : null,
      choice.hasPaperclipConfig ? "paperclip" : "no-paperclip-config",
    ].filter((value): value is string => value !== null);
    p.log.message(`${choice.branchLabel}  ${choice.worktree}  [${flags.join(", ")}]`);
  }
}

function resolveEndpointFromChoice(choice: MergeSourceChoice): ResolvedWorktreeEndpoint {
  if (choice.isCurrent) {
    return resolveCurrentEndpoint();
  }
  return {
    rootPath: choice.worktree,
    configPath: path.resolve(choice.worktree, ".paperclip", "config.json"),
    label: choice.branchLabel,
    isCurrent: false,
  };
}

function resolveWorktreeEndpointFromSelector(
  selector: string,
  opts?: { allowCurrent?: boolean },
): ResolvedWorktreeEndpoint {
  const trimmed = selector.trim();
  const allowCurrent = opts?.allowCurrent !== false;
  if (trimmed.length === 0) {
    throw new Error("Worktree selector cannot be empty.");
  }

  const currentEndpoint = resolveCurrentEndpoint();
  if (allowCurrent && trimmed === "current") {
    return currentEndpoint;
  }

  const choices = toMergeSourceChoices(process.cwd());
  const directPath = path.resolve(trimmed);
  if (existsSync(directPath)) {
    if (allowCurrent && directPath === currentEndpoint.rootPath) {
      return currentEndpoint;
    }
    const configPath = path.resolve(directPath, ".paperclip", "config.json");
    if (!existsSync(configPath)) {
      throw new Error(`Resolved worktree path ${directPath} does not contain .paperclip/config.json.`);
    }
    return {
      rootPath: directPath,
      configPath,
      label: path.basename(directPath),
      isCurrent: false,
    };
  }

  const matched = choices.find((choice) =>
    (allowCurrent || !choice.isCurrent)
    && (choice.worktree === directPath
      || path.basename(choice.worktree) === trimmed
      || choice.branchLabel === trimmed),
  );
  if (!matched) {
    throw new Error(
      `Could not resolve worktree "${selector}". Use a path, a listed worktree directory name, branch name, or "current".`,
    );
  }
  if (!matched.hasPaperclipConfig && !matched.isCurrent) {
    throw new Error(`Resolved worktree "${selector}" does not look like a Paperclip worktree.`);
  }
  return resolveEndpointFromChoice(matched);
}

async function promptForSourceEndpoint(excludeWorktreePath?: string): Promise<ResolvedWorktreeEndpoint> {
  const excluded = excludeWorktreePath ? path.resolve(excludeWorktreePath) : null;
  const currentEndpoint = resolveCurrentEndpoint();
  const choices = toMergeSourceChoices(process.cwd())
    .filter((choice) => choice.hasPaperclipConfig || choice.isCurrent)
    .filter((choice) => path.resolve(choice.worktree) !== excluded)
    .map((choice) => ({
      value: choice.isCurrent ? "__current__" : choice.worktree,
      label: choice.branchLabel,
      hint: `${choice.worktree}${choice.isCurrent ? " (current)" : ""}`,
    }));
  if (choices.length === 0) {
    throw new Error("No Paperclip worktrees were found. Run `paperclipai worktree:list` to inspect the repo worktrees.");
  }
  const selection = await p.select<string>({
    message: "Choose the source worktree to import from",
    options: choices,
  });
  if (p.isCancel(selection)) {
    throw new Error("Source worktree selection cancelled.");
  }
  if (selection === "__current__") {
    return currentEndpoint;
  }
  return resolveWorktreeEndpointFromSelector(selection, { allowCurrent: true });
}

async function applyMergePlan(input: {
  sourceStorages: ConfiguredStorage[];
  targetStorage: ConfiguredStorage;
  targetDb: ClosableDb;
  company: ResolvedMergeCompany;
  plan: Awaited<ReturnType<typeof collectMergePlan>>["plan"];
}) {
  const companyId = input.company.id;

  return await input.targetDb.transaction(async (tx) => {
    const importedProjectIds = input.plan.projectImports.map((project) => project.source.id);
    const existingImportedProjectIds = importedProjectIds.length > 0
      ? new Set(
        (await tx
          .select({ id: projects.id })
          .from(projects)
          .where(inArray(projects.id, importedProjectIds)))
          .map((row) => row.id),
      )
      : new Set<string>();
    const projectImports = input.plan.projectImports.filter((project) => !existingImportedProjectIds.has(project.source.id));
    const importedWorkspaceIds = projectImports.flatMap((project) => project.workspaces.map((workspace) => workspace.id));
    const existingImportedWorkspaceIds = importedWorkspaceIds.length > 0
      ? new Set(
        (await tx
          .select({ id: projectWorkspaces.id })
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.id, importedWorkspaceIds)))
          .map((row) => row.id),
      )
      : new Set<string>();

    let insertedProjects = 0;
    let insertedProjectWorkspaces = 0;
    for (const project of projectImports) {
      await tx.insert(projects).values({
        id: project.source.id,
        companyId,
        goalId: project.targetGoalId,
        name: project.source.name,
        description: project.source.description,
        status: project.source.status,
        leadAgentId: project.targetLeadAgentId,
        targetDate: project.source.targetDate,
        color: project.source.color,
        pauseReason: project.source.pauseReason,
        pausedAt: project.source.pausedAt,
        executionWorkspacePolicy: project.source.executionWorkspacePolicy,
        archivedAt: project.source.archivedAt,
        createdAt: project.source.createdAt,
        updatedAt: project.source.updatedAt,
      });
      insertedProjects += 1;

      for (const workspace of project.workspaces) {
        if (existingImportedWorkspaceIds.has(workspace.id)) continue;
        await tx.insert(projectWorkspaces).values({
          id: workspace.id,
          companyId,
          projectId: project.source.id,
          name: workspace.name,
          sourceType: workspace.sourceType,
          cwd: workspace.cwd,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          defaultRef: workspace.defaultRef,
          visibility: workspace.visibility,
          setupCommand: workspace.setupCommand,
          cleanupCommand: workspace.cleanupCommand,
          remoteProvider: workspace.remoteProvider,
          remoteWorkspaceRef: workspace.remoteWorkspaceRef,
          sharedWorkspaceKey: workspace.sharedWorkspaceKey,
          metadata: workspace.metadata,
          isPrimary: workspace.isPrimary,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        });
        insertedProjectWorkspaces += 1;
      }
    }

    const issueCandidates = input.plan.issuePlans.filter(
      (plan): plan is PlannedIssueInsert => plan.action === "insert",
    );
    const issueCandidateIds = issueCandidates.map((issue) => issue.source.id);
    const existingIssueIds = issueCandidateIds.length > 0
      ? new Set(
        (await tx
          .select({ id: issues.id })
          .from(issues)
          .where(inArray(issues.id, issueCandidateIds)))
          .map((row) => row.id),
      )
      : new Set<string>();
    const issueInserts = issueCandidates.filter((issue) => !existingIssueIds.has(issue.source.id));

    let nextIssueNumber = 0;
    if (issueInserts.length > 0) {
      const [companyRow] = await tx
        .update(companies)
        .set({ issueCounter: sql`${companies.issueCounter} + ${issueInserts.length}` })
        .where(eq(companies.id, companyId))
        .returning({ issueCounter: companies.issueCounter });
      nextIssueNumber = companyRow.issueCounter - issueInserts.length + 1;
    }

    const insertedIssueIdentifiers = new Map<string, string>();
    let insertedIssues = 0;
    for (const issue of issueInserts) {
      const issueNumber = nextIssueNumber;
      nextIssueNumber += 1;
      const identifier = `${input.company.issuePrefix}-${issueNumber}`;
      insertedIssueIdentifiers.set(issue.source.id, identifier);
      await tx.insert(issues).values({
        id: issue.source.id,
        companyId,
        projectId: issue.targetProjectId,
        projectWorkspaceId: issue.targetProjectWorkspaceId,
        goalId: issue.targetGoalId,
        parentId: issue.source.parentId,
        title: issue.source.title,
        description: issue.source.description,
        status: issue.targetStatus,
        priority: issue.source.priority,
        assigneeAgentId: issue.targetAssigneeAgentId,
        assigneeUserId: issue.source.assigneeUserId,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: issue.targetCreatedByAgentId,
        createdByUserId: issue.source.createdByUserId,
        issueNumber,
        identifier,
        requestDepth: issue.source.requestDepth,
        billingCode: issue.source.billingCode,
        assigneeAdapterOverrides: issue.targetAssigneeAgentId ? issue.source.assigneeAdapterOverrides : null,
        executionWorkspaceId: null,
        executionWorkspacePreference: null,
        executionWorkspaceSettings: null,
        startedAt: issue.source.startedAt,
        completedAt: issue.source.completedAt,
        cancelledAt: issue.source.cancelledAt,
        hiddenAt: issue.source.hiddenAt,
        createdAt: issue.source.createdAt,
        updatedAt: issue.source.updatedAt,
      });
      insertedIssues += 1;
    }

    const commentCandidates = input.plan.commentPlans.filter(
      (plan): plan is PlannedCommentInsert => plan.action === "insert",
    );
    const commentCandidateIds = commentCandidates.map((comment) => comment.source.id);
    const existingCommentIds = commentCandidateIds.length > 0
      ? new Set(
        (await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(inArray(issueComments.id, commentCandidateIds)))
          .map((row) => row.id),
      )
      : new Set<string>();

    let insertedComments = 0;
    for (const comment of commentCandidates) {
      if (existingCommentIds.has(comment.source.id)) continue;
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, comment.source.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;
      await tx.insert(issueComments).values({
        id: comment.source.id,
        companyId,
        issueId: comment.source.issueId,
        authorAgentId: comment.targetAuthorAgentId,
        authorUserId: comment.source.authorUserId,
        body: comment.source.body,
        createdAt: comment.source.createdAt,
        updatedAt: comment.source.updatedAt,
      });
      insertedComments += 1;
    }

    const documentCandidates = input.plan.documentPlans.filter(
      (plan): plan is PlannedIssueDocumentInsert | PlannedIssueDocumentMerge =>
        plan.action === "insert" || plan.action === "merge_existing",
    );
    let insertedDocuments = 0;
    let mergedDocuments = 0;
    let insertedDocumentRevisions = 0;
    for (const documentPlan of documentCandidates) {
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, documentPlan.source.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;

      const conflictingKeyDocument = await tx
        .select({ documentId: issueDocuments.documentId })
        .from(issueDocuments)
        .where(and(eq(issueDocuments.issueId, documentPlan.source.issueId), eq(issueDocuments.key, documentPlan.source.key)))
        .then((rows) => rows[0] ?? null);
      if (
        conflictingKeyDocument
        && conflictingKeyDocument.documentId !== documentPlan.source.documentId
      ) {
        continue;
      }

      const existingDocument = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, documentPlan.source.documentId))
        .then((rows) => rows[0] ?? null);

      if (!existingDocument) {
        await tx.insert(documents).values({
          id: documentPlan.source.documentId,
          companyId,
          title: documentPlan.source.title,
          format: documentPlan.source.format,
          latestBody: documentPlan.source.latestBody,
          latestRevisionId: documentPlan.latestRevisionId,
          latestRevisionNumber: documentPlan.latestRevisionNumber,
          createdByAgentId: documentPlan.targetCreatedByAgentId,
          createdByUserId: documentPlan.source.createdByUserId,
          updatedByAgentId: documentPlan.targetUpdatedByAgentId,
          updatedByUserId: documentPlan.source.updatedByUserId,
          createdAt: documentPlan.source.documentCreatedAt,
          updatedAt: documentPlan.source.documentUpdatedAt,
        });
        await tx.insert(issueDocuments).values({
          id: documentPlan.source.id,
          companyId,
          issueId: documentPlan.source.issueId,
          documentId: documentPlan.source.documentId,
          key: documentPlan.source.key,
          createdAt: documentPlan.source.linkCreatedAt,
          updatedAt: documentPlan.source.linkUpdatedAt,
        });
        insertedDocuments += 1;
      } else {
        const existingLink = await tx
          .select({ id: issueDocuments.id })
          .from(issueDocuments)
          .where(eq(issueDocuments.documentId, documentPlan.source.documentId))
          .then((rows) => rows[0] ?? null);
        if (!existingLink) {
          await tx.insert(issueDocuments).values({
            id: documentPlan.source.id,
            companyId,
            issueId: documentPlan.source.issueId,
            documentId: documentPlan.source.documentId,
            key: documentPlan.source.key,
            createdAt: documentPlan.source.linkCreatedAt,
            updatedAt: documentPlan.source.linkUpdatedAt,
          });
        } else {
          await tx
            .update(issueDocuments)
            .set({
              issueId: documentPlan.source.issueId,
              key: documentPlan.source.key,
              updatedAt: documentPlan.source.linkUpdatedAt,
            })
            .where(eq(issueDocuments.documentId, documentPlan.source.documentId));
        }

        await tx
          .update(documents)
          .set({
            title: documentPlan.source.title,
            format: documentPlan.source.format,
            latestBody: documentPlan.source.latestBody,
            latestRevisionId: documentPlan.latestRevisionId,
            latestRevisionNumber: documentPlan.latestRevisionNumber,
            updatedByAgentId: documentPlan.targetUpdatedByAgentId,
            updatedByUserId: documentPlan.source.updatedByUserId,
            updatedAt: documentPlan.source.documentUpdatedAt,
          })
          .where(eq(documents.id, documentPlan.source.documentId));
        mergedDocuments += 1;
      }

      const existingRevisionIds = new Set(
        (
          await tx
            .select({ id: documentRevisions.id })
            .from(documentRevisions)
            .where(eq(documentRevisions.documentId, documentPlan.source.documentId))
        ).map((row) => row.id),
      );
      for (const revisionPlan of documentPlan.revisionsToInsert) {
        if (existingRevisionIds.has(revisionPlan.source.id)) continue;
        await tx.insert(documentRevisions).values({
          id: revisionPlan.source.id,
          companyId,
          documentId: documentPlan.source.documentId,
          revisionNumber: revisionPlan.targetRevisionNumber,
          body: revisionPlan.source.body,
          changeSummary: revisionPlan.source.changeSummary,
          createdByAgentId: revisionPlan.targetCreatedByAgentId,
          createdByUserId: revisionPlan.source.createdByUserId,
          createdAt: revisionPlan.source.createdAt,
        });
        insertedDocumentRevisions += 1;
      }
    }

    const attachmentCandidates = input.plan.attachmentPlans.filter(
      (plan): plan is PlannedAttachmentInsert => plan.action === "insert",
    );
    const existingAttachmentIds = new Set(
      (
        await tx
          .select({ id: issueAttachments.id })
          .from(issueAttachments)
          .where(eq(issueAttachments.companyId, companyId))
      ).map((row) => row.id),
    );
    let insertedAttachments = 0;
    let skippedMissingAttachmentObjects = 0;
    for (const attachment of attachmentCandidates) {
      if (existingAttachmentIds.has(attachment.source.id)) continue;
      const parentExists = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, attachment.source.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parentExists) continue;

      const body = await readSourceAttachmentBody(
        input.sourceStorages,
        companyId,
        attachment.source.objectKey,
      );
      if (!body) {
        skippedMissingAttachmentObjects += 1;
        continue;
      }
      await input.targetStorage.putObject(
        companyId,
        attachment.source.objectKey,
        body,
        attachment.source.contentType,
      );

      await tx.insert(assets).values({
        id: attachment.source.assetId,
        companyId,
        provider: attachment.source.provider,
        objectKey: attachment.source.objectKey,
        contentType: attachment.source.contentType,
        byteSize: attachment.source.byteSize,
        sha256: attachment.source.sha256,
        originalFilename: attachment.source.originalFilename,
        createdByAgentId: attachment.targetCreatedByAgentId,
        createdByUserId: attachment.source.createdByUserId,
        createdAt: attachment.source.assetCreatedAt,
        updatedAt: attachment.source.assetUpdatedAt,
      });

      await tx.insert(issueAttachments).values({
        id: attachment.source.id,
        companyId,
        issueId: attachment.source.issueId,
        assetId: attachment.source.assetId,
        issueCommentId: attachment.targetIssueCommentId,
        createdAt: attachment.source.attachmentCreatedAt,
        updatedAt: attachment.source.attachmentUpdatedAt,
      });
      insertedAttachments += 1;
    }

    return {
      insertedProjects,
      insertedProjectWorkspaces,
      insertedIssues,
      insertedComments,
      insertedDocuments,
      mergedDocuments,
      insertedDocumentRevisions,
      insertedAttachments,
      skippedMissingAttachmentObjects,
      insertedIssueIdentifiers,
    };
  });
}

export async function worktreeMergeHistoryCommand(sourceArg: string | undefined, opts: WorktreeMergeHistoryOptions): Promise<void> {
  if (opts.apply && opts.dry) {
    throw new Error("Use either --apply or --dry, not both.");
  }

  if (sourceArg && opts.from) {
    throw new Error("Use either the positional source argument or --from, not both.");
  }

  const targetEndpoint = opts.to
    ? resolveWorktreeEndpointFromSelector(opts.to, { allowCurrent: true })
    : resolveCurrentEndpoint();
  const sourceEndpoint = opts.from
    ? resolveWorktreeEndpointFromSelector(opts.from, { allowCurrent: true })
    : sourceArg
      ? resolveWorktreeEndpointFromSelector(sourceArg, { allowCurrent: true })
      : await promptForSourceEndpoint(targetEndpoint.rootPath);

  if (path.resolve(sourceEndpoint.configPath) === path.resolve(targetEndpoint.configPath)) {
    throw new Error("Source and target Paperclip configs are the same. Choose different --from/--to worktrees.");
  }

  const scopes = parseWorktreeMergeScopes(opts.scope);
  const sourceHandle = await openConfiguredDb(sourceEndpoint.configPath);
  const targetHandle = await openConfiguredDb(targetEndpoint.configPath);
  const sourceStorages = resolveAttachmentLookupStorages({
    sourceEndpoint,
    targetEndpoint,
  });
  const targetStorage = openConfiguredStorage(targetEndpoint.configPath);

  try {
    const company = await resolveMergeCompany({
      sourceDb: sourceHandle.db,
      targetDb: targetHandle.db,
      selector: opts.company,
    });
    let collected = await collectMergePlan({
      sourceDb: sourceHandle.db,
      targetDb: targetHandle.db,
      company,
      scopes,
    });
    if (!opts.yes) {
      const projectSelections = await promptForProjectMappings({
        plan: collected.plan,
        sourceProjects: collected.sourceProjects,
        targetProjects: collected.targetProjects,
      });
      if (
        projectSelections.importProjectIds.length > 0
        || Object.keys(projectSelections.projectIdOverrides).length > 0
      ) {
        collected = await collectMergePlan({
          sourceDb: sourceHandle.db,
          targetDb: targetHandle.db,
          company,
          scopes,
          importProjectIds: projectSelections.importProjectIds,
          projectIdOverrides: projectSelections.projectIdOverrides,
        });
      }
    }

    console.log(renderMergePlan(collected.plan, {
      sourcePath: `${sourceEndpoint.label} (${sourceEndpoint.rootPath})`,
      targetPath: `${targetEndpoint.label} (${targetEndpoint.rootPath})`,
      unsupportedRunCount: collected.unsupportedRunCount,
    }));

    if (!opts.apply) {
      return;
    }

    const confirmed = opts.yes
      ? true
      : await p.confirm({
        message: `Import ${collected.plan.counts.issuesToInsert} issues and ${collected.plan.counts.commentsToInsert} comments from ${sourceEndpoint.label} into ${targetEndpoint.label}?`,
        initialValue: false,
      });
    if (p.isCancel(confirmed) || !confirmed) {
      p.log.warn("Import cancelled.");
      return;
    }

    const applied = await applyMergePlan({
      sourceStorages,
      targetStorage,
      targetDb: targetHandle.db,
      company,
      plan: collected.plan,
    });
    if (applied.skippedMissingAttachmentObjects > 0) {
      p.log.warn(
        `Skipped ${applied.skippedMissingAttachmentObjects} attachments whose source files were missing from storage.`,
      );
    }
    p.outro(
      pc.green(
        `Imported ${applied.insertedProjects} projects (${applied.insertedProjectWorkspaces} workspaces), ${applied.insertedIssues} issues, ${applied.insertedComments} comments, ${applied.insertedDocuments} documents (${applied.insertedDocumentRevisions} revisions, ${applied.mergedDocuments} merged), and ${applied.insertedAttachments} attachments into ${company.issuePrefix}.`,
      ),
    );
  } finally {
    await targetHandle.stop();
    await sourceHandle.stop();
  }
}

export function registerWorktreeCommands(program: Command): void {
  const worktree = program.command("worktree").description("Worktree-local Paperclip instance helpers");

  program
    .command("worktree:make")
    .description("Create ~/NAME as a git worktree, then initialize an isolated Paperclip instance inside it")
    .argument("<name>", "Worktree name — auto-prefixed with paperclip- if needed (created at ~/paperclip-NAME)")
    .option("--start-point <ref>", "Remote ref to base the new branch on (env: PAPERCLIP_WORKTREE_START_POINT)")
    .option("--instance <id>", "Explicit isolated instance id")
    .option("--home <path>", `Home root for worktree instances (env: PAPERCLIP_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--from-config <path>", "Source config.json to seed from")
    .option("--from-data-dir <path>", "Source PAPERCLIP_HOME used when deriving the source config")
    .option("--from-instance <id>", "Source instance id when deriving the source config", "default")
    .option("--server-port <port>", "Preferred server port", (value) => Number(value))
    .option("--db-port <port>", "Preferred embedded Postgres port", (value) => Number(value))
    .option("--seed-mode <mode>", "Seed profile: minimal or full (default: minimal)", "minimal")
    .option("--no-seed", "Skip database seeding from the source instance")
    .option("--force", "Replace existing repo-local config and isolated instance data", false)
    .action(worktreeMakeCommand);

  worktree
    .command("init")
    .description("Create repo-local config/env and an isolated instance for this worktree")
    .option("--name <name>", "Display name used to derive the instance id")
    .option("--instance <id>", "Explicit isolated instance id")
    .option("--home <path>", `Home root for worktree instances (env: PAPERCLIP_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--from-config <path>", "Source config.json to seed from")
    .option("--from-data-dir <path>", "Source PAPERCLIP_HOME used when deriving the source config")
    .option("--from-instance <id>", "Source instance id when deriving the source config", "default")
    .option("--server-port <port>", "Preferred server port", (value) => Number(value))
    .option("--db-port <port>", "Preferred embedded Postgres port", (value) => Number(value))
    .option("--seed-mode <mode>", "Seed profile: minimal or full (default: minimal)", "minimal")
    .option("--no-seed", "Skip database seeding from the source instance")
    .option("--force", "Replace existing repo-local config and isolated instance data", false)
    .action(worktreeInitCommand);

  worktree
    .command("env")
    .description("Print shell exports for the current worktree-local Paperclip instance")
    .option("-c, --config <path>", "Path to config file")
    .option("--json", "Print JSON instead of shell exports")
    .action(worktreeEnvCommand);

  program
    .command("worktree:list")
    .description("List git worktrees visible from this repo and whether they look like Paperclip worktrees")
    .option("--json", "Print JSON instead of text output")
    .action(worktreeListCommand);

  program
    .command("worktree:merge-history")
    .description("Preview or import issue/comment history from another worktree into the current instance")
    .argument("[source]", "Optional source worktree path, directory name, or branch name (back-compat alias for --from)")
    .option("--from <worktree>", "Source worktree path, directory name, branch name, or current")
    .option("--to <worktree>", "Target worktree path, directory name, branch name, or current (defaults to current)")
    .option("--company <id-or-prefix>", "Shared company id or issue prefix inside the chosen source/target instances")
    .option("--scope <items>", "Comma-separated scopes to import (issues, comments)", "issues,comments")
    .option("--apply", "Apply the import after previewing the plan", false)
    .option("--dry", "Preview only and do not import anything", false)
    .option("--yes", "Skip the interactive confirmation prompt when applying", false)
    .action(worktreeMergeHistoryCommand);

  program
    .command("worktree:cleanup")
    .description("Safely remove a worktree, its branch, and its isolated instance data")
    .argument("<name>", "Worktree name — auto-prefixed with paperclip- if needed")
    .option("--instance <id>", "Explicit instance id (if different from the worktree name)")
    .option("--home <path>", `Home root for worktree instances (env: PAPERCLIP_WORKTREES_DIR, default: ${DEFAULT_WORKTREE_HOME})`)
    .option("--force", "Bypass safety checks (uncommitted changes, unique commits)", false)
    .action(worktreeCleanupCommand);
}
