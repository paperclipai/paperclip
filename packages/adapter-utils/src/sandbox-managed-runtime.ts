import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildRemoteGitDeltaBundleScript,
  createImportedGitRef,
  createRemoteGitExportRef,
  deleteLocalGitRef,
  fetchGitBundleIntoLocalRef,
  GIT_ARCHIVE_EXCLUDES,
  integrateImportedGitHead,
  readGitWorkspaceSnapshot,
  resetLocalGitIndexToHead,
  withShallowGitWorkspaceClone,
} from "./git-workspace-sync.js";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline } from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
  type RuntimeStatusPhase,
  type RuntimeStatusSink,
} from "./runtime-progress.js";
import { isRelativePathOrDescendant, shouldExcludePath } from "./exclude-patterns.js";

const execFile = promisify(execFileCallback);
const CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME = "codex-auth-merge-extract.sh";
const CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME = "codex-auth-merge-decision.cjs";
const CODEX_AUTH_MERGE_EXTRACT_SCRIPT_BYTES = readFileSync(
  new URL(`./${CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME}`, import.meta.url),
);
const CODEX_AUTH_MERGE_DECISION_SCRIPT_BYTES = readFileSync(
  new URL(`./${CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME}`, import.meta.url),
);
const SANDBOX_WORKSPACE_HEAVY_DIR_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
] as const;
const SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES = SANDBOX_WORKSPACE_HEAVY_DIR_NAMES.flatMap((entry) => [
  entry,
  `${entry}/*`,
  `*/${entry}`,
  `*/${entry}/*`,
]);
const CODEX_AUTH_JSON_NAME = "auth.json";
const CODEX_AUTH_JSON_MAX_BYTES = 64 * 1024;
export const SANDBOX_READ_FILE_TOO_LARGE_ERROR_CODE = "ERR_PAPERCLIP_SANDBOX_FILE_TOO_LARGE";

export interface SandboxRemoteExecutionSpec {
  transport: "sandbox";
  provider: string;
  sandboxId: string;
  remoteCwd: string;
  timeoutMs: number;
  apiKey: string | null;
}

export interface SandboxManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

/**
 * Per-call byte-level progress hook. `transferredBytes`/`totalBytes` are decoded
 * file bytes (not the base64 wire size). `totalBytes` is null when the size is
 * not known up front. The transport is the source of truth for byte counts; the
 * orchestrator owns the phase label and direction. Read callers may set
 * `maxBytes` to ask transports to reject oversized files before downloading the
 * full payload when the remote size is knowable.
 */
export interface SandboxTransferProgressOptions {
  onProgress?: (transferredBytes: number, totalBytes: number | null) => void | Promise<void>;
  maxBytes?: number;
}

export interface SandboxManagedRuntimeClient {
  makeDir(remotePath: string): Promise<void>;
  writeFile(remotePath: string, bytes: ArrayBuffer, options?: SandboxTransferProgressOptions): Promise<void>;
  readFile(
    remotePath: string,
    options?: SandboxTransferProgressOptions,
  ): Promise<Buffer | Uint8Array | ArrayBuffer>;
  listFiles(remotePath: string): Promise<string[]>;
  remove(remotePath: string): Promise<void>;
  run(command: string, options: { timeoutMs: number }): Promise<void>;
}

export interface PreparedSandboxManagedRuntime {
  spec: SandboxRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

type ParsedCodexAuth =
  | { kind: "unusable" }
  | { kind: "apikey"; canonicalPayload: CanonicalCodexApiKeyAuth }
  | {
    kind: "subscription";
    accountId: string;
    lastRefresh: number | null;
    canonicalPayload: CanonicalCodexSubscriptionAuth;
  };

type CodexAuthTokenField = "id_token" | "access_token" | "refresh_token";
const CODEX_AUTH_TOKEN_FIELDS = [
  "id_token",
  "access_token",
  "refresh_token",
] as const satisfies readonly CodexAuthTokenField[];

interface CanonicalCodexSubscriptionAuth {
  tokens: { account_id: string } & Partial<Record<CodexAuthTokenField, string>>;
  last_refresh?: string;
}

interface CanonicalCodexApiKeyAuth {
  OPENAI_API_KEY: string;
}

type CodexAuthSyncBackOutcome =
  | "updated"
  | "skipped_no_host_symlink"
  | "skipped_sandbox_auth_missing"
  | "skipped_unusable_auth"
  | "skipped_api_key_auth"
  | "skipped_account_mismatch"
  | "skipped_not_newer";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildExtractRuntimeAssetCommand(input: {
  adapterKey: string;
  assetKey: string;
  remoteAssetDir: string;
  remoteAssetTar: string;
  remoteCodexAuthMergeExtractScript?: string;
}): string {
  if (input.adapterKey !== "codex" || input.assetKey !== "home") {
    return `rm -rf ${shellQuote(input.remoteAssetDir)} && ` +
      `mkdir -p ${shellQuote(input.remoteAssetDir)} && ` +
      `tar -xf ${shellQuote(input.remoteAssetTar)} -C ${shellQuote(input.remoteAssetDir)} && ` +
      `rm -f ${shellQuote(input.remoteAssetTar)}`;
  }

  if (!input.remoteCodexAuthMergeExtractScript) {
    throw new Error("Codex auth merge extract script path is required for codex home assets");
  }

  return `sh ${shellQuote(input.remoteCodexAuthMergeExtractScript)} ` +
    `${shellQuote(input.remoteAssetDir)} ${shellQuote(input.remoteAssetTar)}`;
}

export function parseSandboxRemoteExecutionSpec(value: unknown): SandboxRemoteExecutionSpec | null {
  const parsed = asObject(value);
  const transport = asString(parsed.transport).trim();
  const provider = asString(parsed.provider).trim();
  const sandboxId = asString(parsed.sandboxId).trim();
  const remoteCwd = asString(parsed.remoteCwd).trim();
  const timeoutMs = asNumber(parsed.timeoutMs);

  if (
    transport !== "sandbox" ||
    provider.length === 0 ||
    sandboxId.length === 0 ||
    remoteCwd.length === 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return null;
  }

  return {
    transport: "sandbox",
    provider,
    sandboxId,
    remoteCwd,
    timeoutMs,
    apiKey: asString(parsed.apiKey).trim() || null,
  };
}

export function buildSandboxExecutionSessionIdentity(spec: SandboxRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "sandbox",
    provider: spec.provider,
    sandboxId: spec.sandboxId,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function sandboxExecutionSessionMatches(saved: unknown, current: SandboxRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildSandboxExecutionSessionIdentity(current);
  if (!currentIdentity) return false;
  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.provider) === currentIdentity.provider &&
    asString(parsedSaved.sandboxId) === currentIdentity.sandboxId &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function execTar(args: string[]): Promise<void> {
  await execFile("tar", args, {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function createTarballFromDirectory(input: {
  localDir: string;
  archivePath: string;
  exclude?: string[];
  followSymlinks?: boolean;
}): Promise<void> {
  const excludeArgs = ["._*", ...(input.exclude ?? [])].flatMap((entry) => ["--exclude", entry]);
  // Archive the directory's top-level entries BY NAME rather than ".". Archiving
  // "." embeds a "./" self-entry whose mode/mtime tar then tries to restore onto
  // the extraction target directory; that chmod/utime fails with "Operation not
  // permitted" when the target is a directory the extracting (non-root) user does
  // not own, e.g. an emptyDir mount in a hardened/gVisor sandbox pod. Enumerating
  // entries avoids the self-entry entirely and is portable across GNU/BSD/busybox
  // tar (no GNU-only --no-overwrite-dir needed). --exclude still filters nested
  // matches and any named entry it matches.
  const entries = (await fs.readdir(input.localDir)).sort((left, right) => left.localeCompare(right));
  if (entries.length === 0) {
    // A workspace can legitimately be empty (blank-workspace agent runs). Write a
    // valid empty tar archive (1024-byte all-zero EOF marker) so extraction is a
    // clean no-op rather than tar refusing to create an empty archive.
    await fs.writeFile(input.archivePath, Buffer.alloc(1024));
    return;
  }
  await execTar([
    "-c",
    // Prevent macOS bsdtar from embedding LIBARCHIVE.xattr.* PAX extended
    // headers for extended attributes (e.g. com.apple.provenance). GNU tar on
    // Linux does not recognise these proprietary headers and fails extraction
    // with "This does not look like a tar archive". COPYFILE_DISABLE=1 (set in
    // execTar) already suppresses AppleDouble ._* sidecar files; --no-xattrs
    // additionally suppresses the inline PAX xattr entries.
    "--no-xattrs",
    ...(input.followSymlinks ? ["-h"] : []),
    "-f",
    input.archivePath,
    "-C",
    input.localDir,
    ...excludeArgs,
    "--",
    ...entries,
  ]);
}

async function extractTarballToDirectory(input: {
  archivePath: string;
  localDir: string;
}): Promise<void> {
  await fs.mkdir(input.localDir, { recursive: true });
  await execTar(["-xf", input.archivePath, "-C", input.localDir]);
}

async function walkDirectory(root: string, relative = ""): Promise<string[]> {
  const current = path.join(root, relative);
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    out.push(nextRelative);
    if (entry.isDirectory()) {
      out.push(...(await walkDirectory(root, nextRelative)));
    }
  }
  return out.sort((left, right) => right.length - left.length);
}

async function copyWorkspaceEntry(sourceRoot: string, targetRoot: string, relative: string): Promise<void> {
  const sourcePath = path.join(sourceRoot, relative);
  const targetPath = path.join(targetRoot, relative);
  const stats = await fs.lstat(sourcePath);

  if (stats.isDirectory()) {
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (stats.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    await fs.symlink(linkTarget, targetPath);
    return;
  }

  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, stats.mode);
}

export async function mirrorDirectory(
  sourceDir: string,
  targetDir: string,
  options: { preserveAbsent?: string[] } = {},
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const preserveAbsent = new Set(options.preserveAbsent ?? []);
  const shouldPreserveAbsent = (relative: string) =>
    [...preserveAbsent].some((candidate) => isRelativePathOrDescendant(relative, candidate));

  const sourceEntries = new Set(await walkDirectory(sourceDir));
  const targetEntries = await walkDirectory(targetDir);
  for (const relative of targetEntries) {
    if (shouldPreserveAbsent(relative)) continue;
    if (!sourceEntries.has(relative)) {
      await fs.rm(path.join(targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const entries = (await walkDirectory(sourceDir)).sort((left, right) => left.localeCompare(right));
  for (const relative of entries) {
    await copyWorkspaceEntry(sourceDir, targetDir, relative);
  }
}

async function copySelectedWorkspaceEntries(input: {
  sourceDir: string;
  targetDir: string;
  relativePaths: string[];
  exclude: string[];
}): Promise<void> {
  await fs.mkdir(input.targetDir, { recursive: true });
  for (const relative of input.relativePaths) {
    if (shouldExcludePath(relative, input.exclude)) continue;
    const sourceStats = await fs.lstat(path.join(input.sourceDir, relative)).catch(() => null);
    if (!sourceStats) continue;
    await copyWorkspaceEntry(input.sourceDir, input.targetDir, relative);
  }
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

type SandboxReadFileTooLargeError = Error & {
  code: typeof SANDBOX_READ_FILE_TOO_LARGE_ERROR_CODE;
  actualBytes: number;
  maxBytes: number;
};

export function createSandboxReadFileTooLargeError(input: {
  remotePath: string;
  actualBytes: number;
  maxBytes: number;
}): SandboxReadFileTooLargeError {
  const error = new Error(
    `Remote file ${input.remotePath} is ${input.actualBytes} bytes, exceeding the ${input.maxBytes} byte limit`,
  ) as SandboxReadFileTooLargeError;
  error.code = SANDBOX_READ_FILE_TOO_LARGE_ERROR_CODE;
  error.actualBytes = input.actualBytes;
  error.maxBytes = input.maxBytes;
  return error;
}

function isSandboxReadFileTooLargeError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : null;
  return code === SANDBOX_READ_FILE_TOO_LARGE_ERROR_CODE;
}

// Co-change notice: this parser mirrors hasUsableAuthPayload in
// packages/adapters/codex-local/src/server/codex-home.ts and parseAuth in
// packages/adapter-utils/src/codex-auth-merge-decision.cjs. If the auth format
// changes (new shape, renamed field), update all sites together.
function parseCodexAuthPayload(authPayload: unknown): ParsedCodexAuth {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return { kind: "unusable" };
  }

  const parsedPayload = authPayload as Record<string, unknown>;
  const apiKey = parsedPayload.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return { kind: "apikey", canonicalPayload: { OPENAI_API_KEY: apiKey } };
  }

  const tokens = parsedPayload.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    return { kind: "unusable" };
  }

  const parsedTokens = tokens as Record<string, unknown>;
  const accountId = typeof parsedTokens.account_id === "string" ? parsedTokens.account_id.trim() : "";
  const hasTokenMaterial = CODEX_AUTH_TOKEN_FIELDS.some((key) => {
    const value = parsedTokens[key];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (!accountId || !hasTokenMaterial) {
    return { kind: "unusable" };
  }

  const canonicalTokens: CanonicalCodexSubscriptionAuth["tokens"] = { account_id: accountId };
  for (const key of CODEX_AUTH_TOKEN_FIELDS) {
    const value = parsedTokens[key];
    if (typeof value === "string") {
      canonicalTokens[key] = value;
    }
  }

  const canonicalPayload: CanonicalCodexSubscriptionAuth = { tokens: canonicalTokens };
  if (typeof parsedPayload.last_refresh === "string") {
    canonicalPayload.last_refresh = parsedPayload.last_refresh;
  }

  const lastRefresh = typeof parsedPayload.last_refresh === "string"
    ? Date.parse(parsedPayload.last_refresh)
    : NaN;
  return {
    kind: "subscription",
    accountId,
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
    canonicalPayload,
  };
}

function parseCodexAuthBytes(bytes: Buffer): ParsedCodexAuth {
  try {
    return parseCodexAuthPayload(JSON.parse(bytes.toString("utf8")));
  } catch {
    return { kind: "unusable" };
  }
}

function canonicalCodexAuthBytes(auth: Extract<ParsedCodexAuth, { kind: "subscription" | "apikey" }>): Buffer {
  return Buffer.from(`${JSON.stringify(auth.canonicalPayload)}\n`, "utf8");
}

type SandboxCodexAuthReadResult =
  | { kind: "found"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "too_large" };

async function readSandboxCodexAuthBytes(input: {
  client: SandboxManagedRuntimeClient;
  remoteHomeDir: string;
}): Promise<SandboxCodexAuthReadResult> {
  const remotePath = path.posix.join(input.remoteHomeDir, CODEX_AUTH_JSON_NAME);
  try {
    const bytes = toBuffer(await input.client.readFile(remotePath, { maxBytes: CODEX_AUTH_JSON_MAX_BYTES }));
    if (bytes.byteLength > CODEX_AUTH_JSON_MAX_BYTES) {
      return { kind: "too_large" };
    }
    return { kind: "found", bytes };
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing" };
    if (isSandboxReadFileTooLargeError(error)) return { kind: "too_large" };
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : null;
  return code === "ENOENT" || code === "ENOTDIR" || code === "NotFound";
}

function errorCodeSuffix(error: unknown): string {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : null;
  return typeof code === "string" && code.trim().length > 0 ? ` (${code.trim()})` : "";
}

function codexAuthSyncBackMessage(outcome: CodexAuthSyncBackOutcome): string {
  switch (outcome) {
    case "updated":
      return "updated host auth source with newer sandbox refresh";
    case "skipped_no_host_symlink":
      return "skipped because host auth.json is not a symlink";
    case "skipped_sandbox_auth_missing":
      return "skipped because sandbox auth.json is missing";
    case "skipped_unusable_auth":
      return "skipped because sandbox or host auth.json is not usable subscription auth";
    case "skipped_api_key_auth":
      return "skipped because API-key auth is not synced back";
    case "skipped_account_mismatch":
      return "skipped because account ids do not match";
    case "skipped_not_newer":
      return "skipped because sandbox auth is not newer";
  }
}

async function emitCodexAuthSyncBackOutcome(input: {
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
  outcome: CodexAuthSyncBackOutcome;
}): Promise<void> {
  const message = `Codex auth.json sync-back: ${codexAuthSyncBackMessage(input.outcome)}`;
  await input.onProgress?.(`[paperclip] ${message}\n`);
  await emitRuntimeStatus(input.onRuntimeProgress, "restore", message);
}

async function resolveHostCodexAuthSymlinkSource(localHomeDir: string): Promise<string | null> {
  const localAuthPath = path.join(localHomeDir, CODEX_AUTH_JSON_NAME);
  const stats = await fs.lstat(localAuthPath).catch(() => null);
  if (!stats?.isSymbolicLink()) return null;

  const linkTarget = await fs.readlink(localAuthPath);
  const resolved = path.resolve(path.dirname(localAuthPath), linkTarget);
  return await fs.realpath(resolved).catch(() => resolved);
}

function decideCodexAuthSyncBack(input: {
  sandboxAuth: ParsedCodexAuth;
  hostAuth: ParsedCodexAuth;
}): CodexAuthSyncBackOutcome {
  if (input.sandboxAuth.kind === "unusable" || input.hostAuth.kind === "unusable") {
    return "skipped_unusable_auth";
  }

  if (input.sandboxAuth.kind === "apikey" || input.hostAuth.kind === "apikey") {
    return "skipped_api_key_auth";
  }

  if (input.sandboxAuth.accountId !== input.hostAuth.accountId) {
    return "skipped_account_mismatch";
  }

  if (
    input.sandboxAuth.lastRefresh === null ||
    input.hostAuth.lastRefresh === null ||
    input.sandboxAuth.lastRefresh <= input.hostAuth.lastRefresh
  ) {
    return "skipped_not_newer";
  }

  return "updated";
}

async function writeFileAtomic0600(targetPath: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.paperclip-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  try {
    await fs.writeFile(tempPath, bytes, { mode: 0o600 });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, targetPath);
    await fs.chmod(targetPath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncCodexHomeAuthJsonBackToHost(input: {
  adapterKey: string;
  assets?: SandboxManagedRuntimeAsset[];
  assetDirs: Record<string, string>;
  client: SandboxManagedRuntimeClient;
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<void> {
  const homeAsset = input.adapterKey === "codex"
    ? input.assets?.find((asset) => asset.key === "home")
    : undefined;
  if (!homeAsset) return;

  let outcome: CodexAuthSyncBackOutcome;
  try {
    const hostAuthSource = await resolveHostCodexAuthSymlinkSource(homeAsset.localDir);
    if (!hostAuthSource) {
      outcome = "skipped_no_host_symlink";
    } else {
      const remoteHomeDir = input.assetDirs[homeAsset.key];
      const sandboxAuthRead = remoteHomeDir
        ? await readSandboxCodexAuthBytes({ client: input.client, remoteHomeDir })
        : { kind: "missing" as const };

      if (sandboxAuthRead.kind === "missing") {
        outcome = "skipped_sandbox_auth_missing";
      } else if (sandboxAuthRead.kind === "too_large") {
        outcome = "skipped_unusable_auth";
      } else {
        const hostAuthBytes = await fs.readFile(hostAuthSource)
          .catch((error: unknown) => {
            if (isMissingFileError(error)) return null;
            throw error;
          });
        const sandboxAuth = parseCodexAuthBytes(sandboxAuthRead.bytes);
        outcome = decideCodexAuthSyncBack({
          sandboxAuth,
          hostAuth: hostAuthBytes ? parseCodexAuthBytes(hostAuthBytes) : { kind: "unusable" },
        });
        if (outcome === "updated" && sandboxAuth.kind === "subscription") {
          await writeFileAtomic0600(hostAuthSource, canonicalCodexAuthBytes(sandboxAuth));
        }
      }
    }
  } catch (error) {
    throw new Error(`Failed to sync Codex auth.json from sandbox to host${errorCodeSuffix(error)}.`);
  }

  await emitCodexAuthSyncBackOutcome({
    onProgress: input.onProgress,
    onRuntimeProgress: input.onRuntimeProgress,
    outcome,
  });
}

function tarExcludeFlags(exclude: string[] | undefined): string {
  return ["._*", ...(exclude ?? [])].map((entry) => `--exclude ${shellQuote(entry)}`).join(" ");
}

function createRemoteTarballFromDirectoryCommand(input: {
  remoteDir: string;
  archivePath: string;
  exclude?: string[];
}): string {
  // Match the local archive path: name top-level entries explicitly so tar
  // does not include a "." self-entry that it later tries to chmod/utime.
  return [
    `mkdir -p ${shellQuote(path.posix.dirname(input.archivePath))}`,
    `cd ${shellQuote(input.remoteDir)}`,
    "set -- *",
    `if [ "$#" -eq 1 ] && [ "$1" = "*" ] && [ ! -e "$1" ] && [ ! -L "$1" ]; then set --; fi`,
    `for entry in .[!.]* ..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; set -- "$@" "$entry"; done`,
    `if [ "$#" -eq 0 ]; then ` +
      `dd if=/dev/zero of=${shellQuote(input.archivePath)} bs=1024 count=1; ` +
      `else tar -cf ${shellQuote(input.archivePath)} ${tarExcludeFlags(input.exclude)} -- "$@"; fi`,
  ].join(" && ");
}

async function emitRuntimeStatus(
  sink: RuntimeStatusSink | undefined,
  phase: RuntimeStatusPhase,
  message: string,
): Promise<void> {
  if (!sink) return;
  await Promise.resolve(sink({ phase, message })).catch(() => undefined);
}

function mergeExcludes(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function preserveFindArgs(entries: string[]): string {
  return entries.map((entry) => `! -name ${shellQuote(entry)}`).join(" ");
}

async function removeDeletedPathsInSandbox(input: {
  client: SandboxManagedRuntimeClient;
  spec: SandboxRemoteExecutionSpec;
  remoteDir: string;
  deletedPaths: string[];
}): Promise<void> {
  if (input.deletedPaths.length === 0) return;
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  await input.client.run(
    `sh -c ${shellQuote(`cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`)}`,
    { timeoutMs: input.spec.timeoutMs },
  );
}

// Bridge a single byte-level transfer to the throttled progress reporter. The
// transport reports decoded bytes via `options.onProgress`; the reporter turns
// them into a throttled, fully-formatted log line. `finish()` emits the terminal
// completion line (idempotent) once the transfer returns.
function makeTransferProgress(
  sink: RuntimeProgressSink | undefined,
  phase: RuntimeProgressPhase,
  direction: RuntimeProgressDirection,
  label?: string,
  runtimeStatus?: {
    sink: RuntimeStatusSink | undefined;
    phase: RuntimeStatusPhase;
  },
): {
  options: SandboxTransferProgressOptions | undefined;
  finish: (doneBytes?: number, totalBytes?: number | null) => Promise<void>;
} {
  if (!sink && !runtimeStatus?.sink) {
    return { options: undefined, finish: async () => {} };
  }
  const reporter = createRuntimeProgressReporter({
    sink: async (line) => {
      await sink?.(line);
      if (runtimeStatus?.sink) {
        await emitRuntimeStatus(
          runtimeStatus.sink,
          runtimeStatus.phase,
          line.replace(/^\[paperclip\]\s*/, "").trim(),
        );
      }
    },
    phase,
    direction,
    target: "sandbox",
    label,
  });
  return {
    options: {
      onProgress: async (transferredBytes, totalBytes) => {
        await reporter.report(transferredBytes, totalBytes);
      },
    },
    finish: async (doneBytes, totalBytes) => {
      await reporter.complete(doneBytes, totalBytes);
    },
  };
}

export async function prepareSandboxManagedRuntime(input: {
  spec: SandboxRemoteExecutionSpec;
  adapterKey: string;
  client: SandboxManagedRuntimeClient;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: SandboxManagedRuntimeAsset[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into writeFile/readFile.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
}): Promise<PreparedSandboxManagedRuntime> {
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const gitSnapshot = await readGitWorkspaceSnapshot(input.workspaceLocalDir);
  const gitIgnoredExcludes = gitSnapshot?.ignoredPaths;
  const workspaceArchiveExclude = mergeExcludes(
    SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES,
    [...GIT_ARCHIVE_EXCLUDES],
    input.workspaceExclude,
    gitIgnoredExcludes,
  );
  const restoreExclude = mergeExcludes(
    SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES,
    [...GIT_ARCHIVE_EXCLUDES],
    [".paperclip-runtime"],
    input.preserveAbsentOnRestore,
    input.workspaceExclude,
    gitIgnoredExcludes,
  );
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: restoreExclude,
  });

  await withTempDir("paperclip-sandbox-sync-", async (tempDir) => {
    const preservedNames = new Set([
      ".paperclip-runtime",
      ...(gitSnapshot ? [".git"] : []),
      ...(input.preserveAbsentOnRestore ?? []),
    ]);
    if (gitSnapshot) {
      await emitRuntimeStatus(input.onRuntimeProgress, "git_sync", "Syncing git history to sandbox");
      await withShallowGitWorkspaceClone({
        localDir: input.workspaceLocalDir,
        snapshot: gitSnapshot,
      }, async (cloneDir) => {
        const gitTarPath = path.join(tempDir, "git-workspace.tar");
        await createTarballFromDirectory({
          localDir: cloneDir,
          archivePath: gitTarPath,
          exclude: [".paperclip-runtime"],
        });
        const gitTarBytes = await fs.readFile(gitTarPath);
        const remoteGitTar = path.posix.join(runtimeRootDir, "git-workspace-upload.tar");
        await input.client.makeDir(runtimeRootDir);
        const gitUpload = makeTransferProgress(
          input.onProgress,
          "Syncing",
          "to",
          "git history",
          { sink: input.onRuntimeProgress, phase: "git_sync" },
        );
        await input.client.writeFile(remoteGitTar, toArrayBuffer(gitTarBytes), gitUpload.options);
        await gitUpload.finish(gitTarBytes.byteLength, gitTarBytes.byteLength);
        await input.client.run(
          `sh -c ${shellQuote(
            `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
              `find ${shellQuote(workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ${preserveFindArgs([".paperclip-runtime"])} -exec rm -rf -- {} + && ` +
              `tar -xf ${shellQuote(remoteGitTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
              `rm -f ${shellQuote(remoteGitTar)}`,
          )}`,
          { timeoutMs: input.spec.timeoutMs },
        );
      });
    }

    const workspaceTarPath = path.join(tempDir, "workspace.tar");
    const workspaceArchiveDir = gitSnapshot ? path.join(tempDir, "workspace-overlay") : input.workspaceLocalDir;
    await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing workspace to sandbox");
    if (gitSnapshot) {
      await copySelectedWorkspaceEntries({
        sourceDir: input.workspaceLocalDir,
        targetDir: workspaceArchiveDir,
        relativePaths: gitSnapshot.overlayPaths,
        exclude: workspaceArchiveExclude,
      });
    }
    await createTarballFromDirectory({
      localDir: workspaceArchiveDir,
      archivePath: workspaceTarPath,
      exclude: gitSnapshot ? undefined : workspaceArchiveExclude,
    });
    const workspaceTarBytes = await fs.readFile(workspaceTarPath);
    const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-upload.tar");
    await input.client.makeDir(runtimeRootDir);
    const workspaceUpload = makeTransferProgress(
      input.onProgress,
      "Syncing",
      "to",
      "workspace",
      { sink: input.onRuntimeProgress, phase: "config_sync" },
    );
    await input.client.writeFile(
      remoteWorkspaceTar,
      toArrayBuffer(workspaceTarBytes),
      workspaceUpload.options,
    );
    await workspaceUpload.finish(workspaceTarBytes.byteLength, workspaceTarBytes.byteLength);
    const extractWorkspaceTarCommand = gitSnapshot
      ? `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
        `tar -xf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
        `rm -f ${shellQuote(remoteWorkspaceTar)}`
      : `mkdir -p ${shellQuote(workspaceRemoteDir)} && ` +
        `find ${shellQuote(workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ${preserveFindArgs([...preservedNames])} -exec rm -rf -- {} + && ` +
        `tar -xf ${shellQuote(remoteWorkspaceTar)} -C ${shellQuote(workspaceRemoteDir)} && ` +
        `rm -f ${shellQuote(remoteWorkspaceTar)}`;
    await input.client.run(
      `sh -c ${shellQuote(extractWorkspaceTarCommand)}`,
      { timeoutMs: input.spec.timeoutMs },
    );
    if (gitSnapshot) {
      await removeDeletedPathsInSandbox({
        client: input.client,
        spec: input.spec,
        remoteDir: workspaceRemoteDir,
        deletedPaths: gitSnapshot.deletedPaths,
      });
    }

    for (const asset of input.assets ?? []) {
      await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing runtime assets to sandbox");
      const assetTarPath = path.join(tempDir, `${asset.key}.tar`);
      await createTarballFromDirectory({
        localDir: asset.localDir,
        archivePath: assetTarPath,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
      });
      const assetTarBytes = await fs.readFile(assetTarPath);
      const remoteAssetDir = path.posix.join(runtimeRootDir, asset.key);
      const remoteAssetTar = path.posix.join(runtimeRootDir, `${asset.key}-upload.tar`);
      const remoteCodexAuthMergeExtractScript = input.adapterKey === "codex" && asset.key === "home"
        ? path.posix.join(runtimeRootDir, CODEX_AUTH_MERGE_EXTRACT_SCRIPT_NAME)
        : undefined;
      const assetUpload = makeTransferProgress(
        input.onProgress,
        "Syncing",
        "to",
        asset.key,
        { sink: input.onRuntimeProgress, phase: "config_sync" },
      );
      await input.client.writeFile(remoteAssetTar, toArrayBuffer(assetTarBytes), assetUpload.options);
      await assetUpload.finish(assetTarBytes.byteLength, assetTarBytes.byteLength);
      if (remoteCodexAuthMergeExtractScript) {
        await input.client.writeFile(
          remoteCodexAuthMergeExtractScript,
          toArrayBuffer(CODEX_AUTH_MERGE_EXTRACT_SCRIPT_BYTES),
        );
        await input.client.writeFile(
          path.posix.join(runtimeRootDir, CODEX_AUTH_MERGE_DECISION_SCRIPT_NAME),
          toArrayBuffer(CODEX_AUTH_MERGE_DECISION_SCRIPT_BYTES),
        );
      }
      await input.client.run(
        `sh -c ${shellQuote(
          buildExtractRuntimeAssetCommand({
            adapterKey: input.adapterKey,
            assetKey: asset.key,
            remoteAssetDir,
            remoteAssetTar,
            remoteCodexAuthMergeExtractScript,
          }),
        )}`,
        { timeoutMs: input.spec.timeoutMs },
      );
    }
  });

  const assetDirs = Object.fromEntries(
    (input.assets ?? []).map((asset) => [asset.key, path.posix.join(runtimeRootDir, asset.key)]),
  );

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      const restoreSink = onProgress ?? input.onProgress;
      await withTempDir("paperclip-sandbox-restore-", async (tempDir) => {
        let importedRef: string | null = null;
        let importedHead: string | null = null;
        let remoteWorkspaceStatus = "dirty";
        let restoreError: unknown = null;
        try {
          if (gitSnapshot) {
            await emitRuntimeStatus(input.onRuntimeProgress, "export", "Exporting git changes from sandbox");
            importedRef = createImportedGitRef("sandbox");
            const remoteGitBundle = path.posix.join(runtimeRootDir, "git-delta.bundle");
            const remoteWorkspaceStatusPath = path.posix.join(runtimeRootDir, "workspace-status.txt");
            const exportRef = createRemoteGitExportRef("sandbox");
            await input.client.run(
              `sh -c ${shellQuote(buildRemoteGitDeltaBundleScript({
                remoteDir: workspaceRemoteDir,
                baseSha: gitSnapshot.headCommit,
                exportRef,
                bundlePath: remoteGitBundle,
                statusPath: remoteWorkspaceStatusPath,
              }))}`,
              { timeoutMs: input.spec.timeoutMs },
            );
            const gitExport = makeTransferProgress(
              restoreSink,
              "Exporting git history",
              "from",
              undefined,
              { sink: input.onRuntimeProgress, phase: "export" },
            );
            const bundleBytes = await input.client.readFile(remoteGitBundle, gitExport.options);
            const bundleBuffer = toBuffer(bundleBytes);
            await gitExport.finish(bundleBuffer.byteLength, bundleBuffer.byteLength);
            await input.client.remove(remoteGitBundle).catch(() => undefined);
            remoteWorkspaceStatus = await input.client.readFile(remoteWorkspaceStatusPath)
              .then((bytes) => toBuffer(bytes).toString("utf8").trim())
              .catch(() => "dirty");
            remoteWorkspaceStatus = remoteWorkspaceStatus === "clean" ? "clean" : "dirty";
            await input.client.remove(remoteWorkspaceStatusPath).catch(() => undefined);
            const bundlePath = path.join(tempDir, "git-delta.bundle");
            await fs.writeFile(bundlePath, bundleBuffer);
            importedHead = await fetchGitBundleIntoLocalRef({
              localDir: input.workspaceLocalDir,
              bundlePath,
              exportRef,
              importedRef,
              baseSha: gitSnapshot.headCommit,
            });
          }

          const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-download.tar");
          await emitRuntimeStatus(input.onRuntimeProgress, "restore", "Restoring workspace from sandbox");
          await input.client.run(
            `sh -c ${shellQuote(createRemoteTarballFromDirectoryCommand({
              remoteDir: workspaceRemoteDir,
              archivePath: remoteWorkspaceTar,
              exclude: restoreExclude,
            }))}`,
            { timeoutMs: input.spec.timeoutMs },
          );
          const workspaceRestore = makeTransferProgress(
            restoreSink,
            "Restoring",
            "from",
            "workspace",
            { sink: input.onRuntimeProgress, phase: "restore" },
          );
          const archiveBytes = await input.client.readFile(remoteWorkspaceTar, workspaceRestore.options);
          const archiveBuffer = toBuffer(archiveBytes);
          await workspaceRestore.finish(archiveBuffer.byteLength, archiveBuffer.byteLength);
          await input.client.remove(remoteWorkspaceTar).catch(() => undefined);
          const localArchivePath = path.join(tempDir, "workspace.tar");
          const extractedDir = path.join(tempDir, "workspace");
          await fs.writeFile(localArchivePath, archiveBuffer);
          await extractTarballToDirectory({
            archivePath: localArchivePath,
            localDir: extractedDir,
          });
          const gitHeadToIntegrate = importedHead;
          await mergeDirectoryWithBaseline({
            baseline: baselineSnapshot,
            sourceDir: extractedDir,
            targetDir: input.workspaceLocalDir,
            beforeApply: gitHeadToIntegrate
              ? async () => {
                  await integrateImportedGitHead({
                    localDir: input.workspaceLocalDir,
                    importedHead: gitHeadToIntegrate,
                  });
                }
              : undefined,
            afterApply: gitSnapshot
              ? async () => {
                  await resetLocalGitIndexToHead({
                    localDir: input.workspaceLocalDir,
                    checkWorkingTreeClean: remoteWorkspaceStatus === "clean",
                  });
                }
              : undefined,
          });
        } catch (error) {
          restoreError = error;
          throw error;
        } finally {
          let syncBackError: unknown = null;
          try {
            await syncCodexHomeAuthJsonBackToHost({
              adapterKey: input.adapterKey,
              assets: input.assets,
              assetDirs,
              client: input.client,
              onProgress: restoreSink,
              onRuntimeProgress: input.onRuntimeProgress,
            });
          } catch (error) {
            syncBackError = error;
            if (restoreError) {
              await emitRuntimeStatus(
                input.onRuntimeProgress,
                "restore",
                "Codex auth.json sync-back skipped after workspace restore failure",
              );
            }
          }

          await emitRuntimeStatus(input.onRuntimeProgress, "finalize", "Finalizing sandbox workspace");
          if (importedRef) {
            await deleteLocalGitRef({ localDir: input.workspaceLocalDir, ref: importedRef });
          }
          if (!restoreError && syncBackError) {
            throw syncBackError;
          }
        }
      });
    },
  };
}
