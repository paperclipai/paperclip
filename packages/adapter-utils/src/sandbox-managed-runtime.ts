import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  promises as fs,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildRemoteGitDeltaBundleScript,
  isMissingGitPrerequisiteError,
  createImportedGitRef,
  createRemoteGitExportRef,
  deleteLocalGitRef,
  fetchGitBundleIntoLocalRef,
  GIT_ARCHIVE_EXCLUDES,
  type GitWorkspaceSnapshot,
  integrateImportedGitHead,
  readGitWorkspaceSnapshot,
  ReferencedSourceIgnoreScanLimitExceededError,
  readReferencedSourceGitIgnoredPaths,
  resetLocalGitIndexToHead,
  withShallowGitWorkspaceClone,
  WORKSPACE_GIT_SCAN_SATURATED_CODE,
} from "./git-workspace-sync.js";
import {
  captureDirectorySnapshot,
  mergeDirectoryWithBaseline,
  type DirectorySnapshot,
} from "./workspace-restore-merge.js";
import {
  createRuntimeProgressReporter,
  type RuntimeProgressDirection,
  type RuntimeProgressPhase,
  type RuntimeProgressSink,
  type RuntimeStatusPhase,
  type RuntimeStatusSink,
} from "./runtime-progress.js";
import { isRelativePathOrDescendant, shouldExcludePath } from "./exclude-patterns.js";
import {
  scheduleSyncOperations,
  SYNC_OPERATION_CONCURRENCY_LIMIT,
  type SyncOperationTask,
} from "./sync-operation-schedule.js";
import type { RuntimeSpanRunner } from "./acpx-engine/startup-timing.js";

const execFile = promisify(execFileCallback);
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

export interface SandboxRemoteExecutionSpec {
  transport: "sandbox";
  provider: string;
  sandboxId: string;
  remoteCwd: string;
  timeoutMs: number;
  apiKey: string | null;
}

/**
 * Remote paths handed to an asset's `provision.postUploadCommand`. All are POSIX
 * paths inside the sandbox: `assetTarPath` is the uploaded asset tarball,
 * `assetDir` is where the asset should be materialized, and `runtimeRootDir`
 * is the directory any `stageFiles` were written into.
 */
export interface SandboxManagedRuntimeAssetProvisionContext {
  assetTarPath: string;
  assetDir: string;
  runtimeRootDir: string;
}

/**
 * Per-asset inbound provisioning contribution. The core is adapter-agnostic:
 * an asset that supplies neither `stageFiles` nor `postUploadCommand` is
 * materialized with a plain destroy-then-replace `tar -xf`. An adapter that
 * needs custom provisioning (e.g. a credential merge) supplies helper files via
 * `stageFiles` and the shell command that consumes them via `postUploadCommand`.
 *
 * Both contributions ride the unified {@link SandboxSyncOperation} the core
 * builds per asset: `stageFiles` become additional `files` mappings placed
 * alongside the asset tar, and `postUploadCommand` becomes the operation's
 * ordered `postUploadCommands`. See {@link SandboxPostUploadCommand} for the
 * command-origin / confinement security contract (C1–C3).
 */
export interface SandboxManagedRuntimeAssetProvision {
  /**
   * Extra files placed into `runtimeRootDir` (alongside the asset tar) before
   * the post-upload command runs — typically helper scripts the command
   * invokes. Contents may be raw bytes or a UTF-8 string.
   */
  stageFiles?: { name: string; contents: Buffer | string }[];
  /**
   * Builds the opaque, adapter-authored shell command that materializes the
   * uploaded asset tar into `assetDir`, run as the operation's ordered
   * post-upload command after every mapping has landed. Defaults to a plain
   * destroy-then-replace `tar -xf` extraction when omitted. Any path embedded in
   * the command MUST be built from already-confined paths and shell-quoted (C3).
   */
  postUploadCommand?: (ctx: SandboxManagedRuntimeAssetProvisionContext) => string;
}

/**
 * Context passed to an asset's `restore` contribution during teardown.
 * `assetDir` is the asset's directory inside the sandbox and `readFile` reads
 * a file back from the sandbox as raw bytes. `tempDir` is a host scratch
 * directory that belongs to this restore task alone. The shared scheduler can
 * run restore tasks at the same time, so a task must not share scratch space
 * with another task. A restore that needs a host temporary file writes it under
 * `tempDir`. The coordinator removes the directory after the task settles. The
 * sandbox coordinator always sets `tempDir`. A serial runtime that never runs
 * restore tasks at the same time can omit it.
 */
export interface SandboxManagedRuntimeAssetRestoreContext {
  assetDir: string;
  readFile: (remotePath: string) => Promise<Buffer>;
  tempDir?: string;
}

export interface SandboxManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  /** Optional inbound provisioning contribution (staged files + extract command). */
  provision?: SandboxManagedRuntimeAssetProvision;
  /**
   * Optional teardown/outbound contribution, invoked once per asset during
   * `restoreWorkspace`. Defaults to a no-op when omitted.
   */
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

/**
 * How a referenced project's Git-ignored paths were resolved, computed once
 * per project by `resolveReferencedSourceIgnore` before staging starts. The
 * sandbox lane, the SSH lane, and the content-signature walk each consume
 * this ONE resolution, so the three sites never drift apart.
 *
 * - `git`: `localPath` is a Git work tree. `ignoredPaths` are its ignored
 *   entries, already re-relativized to `localPath` (see
 *   `resolveReferencedSourceIgnore`).
 * - `other`: `localPath` is not a Git work tree. The staging path keeps
 *   today's fixed heavy-directory excludes.
 * - `failed`: the Git read failed, timed out, breached a parse bound, or
 *   returned output the resolver could not safely re-relativize. The project
 *   is NOT staged (fail closed) — every site records it as a per-project
 *   failure instead of shipping it unfiltered. `reason` is always one of
 *   {@link REFERENCED_SOURCE_IGNORE_FAILURE_REASONS} — never a raw Git or tar
 *   diagnostic, an absolute host path, or a basename.
 */
export type ReferencedSourceIgnoreResolution =
  | { kind: "git"; ignoredPaths: string[] }
  | { kind: "other" }
  | { kind: "failed"; reason: string };

/**
 * The fixed, allowlisted failure categories a `failed`
 * {@link ReferencedSourceIgnoreResolution} reports as `reason`. This is the
 * ENTIRE vocabulary: no absolute host path, no basename, no opaque token, and
 * no raw Git or tar stderr ever reaches `reason` — only one of these three
 * stable strings, chosen once at the single construction point in
 * `resolveReferencedSourceIgnore`. A `failed` resolution always prevents
 * staging and is always re-resolved before its next use, so two different
 * underlying failures colliding on the same category (e.g. a timeout and a
 * malformed-output error both reporting `scanFailed`) never weakens the
 * fail-closed decision.
 */
export const REFERENCED_SOURCE_IGNORE_FAILURE_REASONS = {
  /** A Git read failed, timed out, was cancelled, or returned malformed output — including a saturated scan queue that never recovered after its retries. */
  scanFailed: "git-ignore-scan-failed",
  /** The parsed ignored-entry count or total UTF-8 byte size breached its bound (see `readReferencedSourceGitIgnoredPaths`). */
  limitExceeded: "git-ignore-scan-limit-exceeded",
  /** The referenced project's `localPath` is not a descendant of its own Git top level. */
  toplevelNotDescendant: "git-toplevel-not-descendant",
} as const;

/**
 * A referenced (additional) project to stage into the run sandbox as a plain,
 * read-only tree. `localPath` is the host checkout directory. Upstream code
 * already authorized and realized this directory (`project:read`); this layer
 * adds no authorization logic. `projectId` names the isolated remote
 * subdirectory (`project-<projectId>` under the runtime root) the tree lands in.
 *
 * Additional sources are plain trees only. They never carry the anchor
 * workspace's git-history, overlay, or `.paperclip-runtime` preservation
 * semantics — those stay anchor-only.
 *
 * `ignoreResolution` is required so every construction site must supply it
 * explicitly — a caller cannot default to the unfiltered legacy behavior by
 * omission. Resolve it once per project with `resolveReferencedSourceIgnore`.
 */
export interface SandboxAdditionalSource {
  localPath: string;
  projectId: string;
  ignoreResolution: ReferencedSourceIgnoreResolution;
}

/**
 * Escape tar `--exclude` glob metacharacters (`*`, `?`, `[`) in a literal
 * path, so a Git-ignored path that happens to contain one of them is matched
 * literally instead of as a pattern. Without this, a repository-controlled
 * path containing e.g. `*` could exclude unrelated sibling files that
 * happen to match the resulting glob. GNU tar and bsdtar both honor a
 * backslash as a `fnmatch` escape character, so this is not command
 * injection — `createTarballFromDirectory` and the SSH tar equivalent both
 * pass `--exclude` values as argument-vector entries, never through a shell.
 */
export function escapeTarExcludeLiteral(entry: string): string {
  return entry.replace(/\\/g, "\\\\").replace(/([*?[])/g, "\\$1");
}

/**
 * The tar `--exclude` entries a referenced project's resolved ignore set
 * contributes, on top of the fixed heavy-directory excludes every site
 * already applies. Empty for `other` (today's fixed excludes are enough)
 * and for `failed` (the project is not staged at all, so no exclude list
 * matters).
 */
export function referencedSourceIgnoreExcludeEntries(resolution: ReferencedSourceIgnoreResolution): string[] {
  return resolution.kind === "git" ? resolution.ignoredPaths.map(escapeTarExcludeLiteral) : [];
}

/**
 * Compute the relative position of `localPath` under a Git `toplevel`
 * directory, as a POSIX path with no leading or trailing slash. Returns `""`
 * when `localPath` IS the toplevel. Returns `null` when the relation is not a
 * plain descendant — `localPath` escapes upward from `toplevel`, resolves to
 * an absolute/rooted result (a different filesystem root), or the two paths
 * are otherwise not comparable. The caller treats `null` as a resolution
 * failure (fail closed), never as "nothing to exclude".
 */
/**
 * Physical (symlink-resolved) form of a path, falling back to the plain
 * resolved form when realpath fails (e.g. the path vanished mid-run — the
 * downstream descendant check then fails closed on the string form).
 * Git prints physical toplevels, so both sides of the descendant comparison
 * must be physical too; comparing a logical path against a physical one makes
 * any symlinked project or temp directory (macOS `/var` → `/private/var`)
 * fail resolution spuriously.
 */
async function physicalPath(input: string): Promise<string> {
  try {
    return await fs.realpath(input);
  } catch {
    return path.resolve(input);
  }
}

function relativizeUnderGitToplevel(input: { toplevel: string; localPath: string }): string | null {
  const toplevel = path.resolve(input.toplevel);
  const localPath = path.resolve(input.localPath);
  const relative = path.relative(toplevel, localPath);
  if (relative === "") return "";
  if (path.isAbsolute(relative)) return null;
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join("/");
}

/**
 * Re-relativize root-relative ignored paths (as `readReferencedSourceGitIgnoredPaths`
 * reports them, from the repository toplevel) to `offset`, the position of
 * the referenced project's `localPath` under that toplevel. Keeps only the
 * entries that are `offset` itself or a descendant of it — an ignored path
 * elsewhere in the repository does not apply to this project's staged tree —
 * and strips the `offset` prefix so the result matches the tar member
 * namespace, which is `localPath`-relative.
 */
function reRelativizeIgnoredPathsToLocalPath(input: { ignoredPaths: string[]; offset: string }): string[] {
  if (input.offset === "") {
    return [...input.ignoredPaths];
  }
  const prefix = `${input.offset}/`;
  return input.ignoredPaths
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter(Boolean);
}

/**
 * Bounded backoff before each retry of a saturated Git scan: none before the
 * first attempt, 1 second before the second, 2 seconds before the third. Three
 * total attempts (the first plus these two retries) is a liveness parameter,
 * not a security control — the retry only ever fires for the scheduler's
 * typed saturation code (see {@link isWorkspaceGitScanSaturatedError}).
 */
const REFERENCED_SOURCE_IGNORE_SCAN_RETRY_DELAYS_MS = [1_000, 2_000] as const;

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * True only when `error` carries the workspace Git scan scheduler's typed
 * saturation code on its `code` property. Matches the code alone, never
 * message text — a message can change wording without changing meaning, and
 * matching text would silently stop retrying (or start retrying the wrong
 * failure) the moment it did.
 */
function isWorkspaceGitScanSaturatedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === WORKSPACE_GIT_SCAN_SATURATED_CODE
  );
}

/**
 * Resolve a referenced project's Git-ignored paths ONCE, before any staging
 * site runs. Called once per project (see `execute.ts`); the sandbox lane,
 * the SSH lane, and the content-signature walk all consume this one result,
 * so they can never apply a different exclusion set to the same project.
 *
 * Fails closed: a Git read error, a timeout, malformed output, a parse-bound
 * breach, or a `localPath` that is not a plain descendant of its own Git
 * toplevel all return `failed`, never an empty ignore list — an empty list
 * means "resolved, nothing extra to exclude", which is a different claim than
 * "the resolution did not run".
 *
 * Retries ONLY a saturated scan queue (the shared workspace Git operation
 * scheduler rejecting before spawn because it is at capacity) — a liveness
 * condition, not an integrity one. Three attempts total, with the bounded
 * backoff in {@link REFERENCED_SOURCE_IGNORE_SCAN_RETRY_DELAYS_MS}, retried
 * through the same registered scheduler every time. No direct-spawn fallback
 * exists: bypassing the scheduler would defeat the process-wide concurrency
 * limit it enforces. Every other failure — timeout, cancellation, an output
 * limit, a permission error, malformed output, a real Git failure, or a bound
 * breach — makes exactly one attempt and fails closed immediately.
 */
export async function resolveReferencedSourceIgnore(localPath: string): Promise<ReferencedSourceIgnoreResolution> {
  let scan: Awaited<ReturnType<typeof readReferencedSourceGitIgnoredPaths>> = null;
  let failureReason: string | null = null;
  for (let attempt = 0; attempt <= REFERENCED_SOURCE_IGNORE_SCAN_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      scan = await readReferencedSourceGitIgnoredPaths(localPath);
      failureReason = null;
      break;
    } catch (error) {
      failureReason = error instanceof ReferencedSourceIgnoreScanLimitExceededError
        ? REFERENCED_SOURCE_IGNORE_FAILURE_REASONS.limitExceeded
        : REFERENCED_SOURCE_IGNORE_FAILURE_REASONS.scanFailed;
      const isLastAttempt = attempt === REFERENCED_SOURCE_IGNORE_SCAN_RETRY_DELAYS_MS.length;
      if (isLastAttempt || !isWorkspaceGitScanSaturatedError(error)) {
        break;
      }
      await delay(REFERENCED_SOURCE_IGNORE_SCAN_RETRY_DELAYS_MS[attempt]!);
    }
  }
  if (failureReason !== null) {
    return { kind: "failed", reason: failureReason };
  }
  if (!scan) {
    return { kind: "other" };
  }
  const offset = relativizeUnderGitToplevel({
    toplevel: await physicalPath(scan.toplevel),
    localPath: await physicalPath(localPath),
  });
  if (offset === null) {
    return { kind: "failed", reason: REFERENCED_SOURCE_IGNORE_FAILURE_REASONS.toplevelNotDescendant };
  }
  return {
    kind: "git",
    ignoredPaths: reRelativizeIgnoredPathsToLocalPath({ ignoredPaths: scan.ignoredPaths, offset }),
  };
}

/**
 * Per-call byte-level progress hook. `transferredBytes`/`totalBytes` are decoded
 * file bytes (not the base64 wire size). `totalBytes` is null when the size is
 * not known up front. The transport is the source of truth for byte counts; the
 * orchestrator owns the phase label and direction.
 */
export interface SandboxTransferProgressOptions {
  onProgress?: (transferredBytes: number, totalBytes: number | null) => void | Promise<void>;
}

/**
 * A single source→target file or directory transfer within a sync operation.
 * Mirrors the plugin SDK `PluginSyncFileMapping`; kept as a local structural
 * type so `adapter-utils` does not depend on the plugin SDK. For `syncIn`,
 * `sourcePath` is a host path and `targetPath` a sandbox path; for `syncOut` the
 * direction is reversed. Sandbox paths are POSIX.
 */
export interface SandboxSyncFileMapping {
  sourcePath: string;
  targetPath: string;
  kind: "file" | "directory";
  mode?: number;
  exclude?: string[];
  followSymlinks?: boolean;
  /**
   * Advisory read-write intent for the sandbox target. `"rw"` marks a target the
   * agent may change and keep; `"ro"` marks a read-only tree. An absent value
   * defaults to `"ro"` (read-only is the safe default for an advisory signal).
   * The field is advisory metadata for an optional sandbox feedback wrapper. It
   * does not change the transfer and adds no security.
   */
  access?: "rw" | "ro";
  /**
   * The sandbox directory that becomes read-write when `access` is `"rw"` and a
   * post-upload command extracts `targetPath` into a different directory. A tar
   * mapping uploads an archive under the runtime root, so its `targetPath` is the
   * staging archive, not the directory the extract command fills. This field
   * names that final destination directory. When absent, the read-write
   * destination is the parent directory of `targetPath`. Advisory; ignored when
   * `access` is not `"rw"`.
   */
  writablePath?: string;
}

/**
 * A control command run against the sandbox after a sync operation's files have
 * landed. Mirrors the plugin SDK `PluginPostUploadCommand`; kept as a local
 * structural type so `adapter-utils` does not depend on the plugin SDK. Ordered
 * within {@link SandboxSyncOperation.postUploadCommands} and executed in array
 * order, fail-fast (first non-zero exit or timeout aborts the operation).
 *
 * SECURITY — command origin (Stage-1 design review, condition C1). `command` is
 * a **Paperclip/adapter-authored control operation**: it may be supplied ONLY by
 * core/adapter code. No server route, issue/comment content, project/workspace
 * file content, provider-plugin callback, or arbitrary adapter config may supply
 * a raw `command` string; any path embedded in it MUST be built by adapter/core
 * helpers from already-confined paths and shell-quoted (C3). Providers treat the
 * command as **opaque** — execute or reject, never rewrite/concatenate/append.
 */
export interface SandboxPostUploadCommand {
  /** The opaque, adapter-authored shell command to run after upload. */
  command: string;
  /**
   * Working directory for the command. When present, MUST be an absolute POSIX
   * path confined under the operation's allowed sandbox target root (C2). When
   * absent, defaults to the runtime's stable command cwd — never a process
   * default cwd.
   */
  cwd?: string;
  /** Optional per-command timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * An ordered, opaque unit of work handed to the native sync transport. The
 * `operationId` is an opaque, non-sensitive token authored by the orchestrator
 * (never a caller/asset identifier that could leak intent); a provider MUST NOT
 * interpret it.
 */
export interface SandboxSyncOperation {
  operationId: string;
  files: SandboxSyncFileMapping[];
  /**
   * Optional ordered control commands run after this operation's files land, in
   * array order, fail-fast. Absent means "no commands" — byte-identical to a
   * pre-contract operation. See {@link SandboxPostUploadCommand} for the command
   * origin/confinement security contract (C1–C4).
   */
  postUploadCommands?: SandboxPostUploadCommand[];
}

export interface SandboxSyncResult {
  operations: { operationId: string; filesTransferred: number; bytesTransferred: number }[];
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
  /**
   * True when the orchestrator may run this client's sync operations
   * concurrently. The base64 fallback always sets it true. A native provider
   * takes the value from the verified `concurrentSyncOperations` opt-in; an
   * undeclared native provider keeps it false. One flag serves both `syncIn` and
   * `syncOut`. `createCommandManagedRuntimeClient` always sets it on a prepared
   * client; it is optional here so a test mock can omit it.
   */
  allowConcurrentSyncOperations?: boolean;
  /**
   * Optional native inbound transfer. Present only when the sandbox provider
   * advertises both `environmentSyncIn` and `environmentSyncOut`; otherwise the
   * orchestrator falls back to the tar + base64 `writeFile`/`run` path so
   * behavior is byte-identical to a provider that never opted in.
   */
  syncIn?(operations: SandboxSyncOperation[]): Promise<SandboxSyncResult>;
  /** Optional native outbound transfer. See {@link syncIn}. */
  syncOut?(operations: SandboxSyncOperation[]): Promise<SandboxSyncResult>;
}

/**
 * Host-side complete-mediation guard for native sync operations. The orchestrator
 * authors every `targetPath`, but the native transport crosses the host↔sandbox
 * trust boundary, so we canonicalize and confine each mapping's source and target
 * to an orchestrator-owned root before handing the operation to a provider.
 * Absolute escapes and `..` traversal are rejected fail-closed. Sandbox and host
 * paths on the server are POSIX.
 */
export function assertSyncOperationsConfined(
  operations: SandboxSyncOperation[],
  roots: { sourceRoots: string[]; targetRoots: string[] },
): void {
  const confine = (candidate: string, allowed: string[], label: string): void => {
    const normalized = path.posix.normalize(candidate);
    if (!path.posix.isAbsolute(normalized) || normalized === ".." || normalized.includes("/../") || normalized.endsWith("/..")) {
      throw new Error(`sync operation ${label} path is not a confined absolute path: ${candidate}`);
    }
    const within = allowed.some((root) => {
      const normalizedRoot = path.posix.normalize(root);
      const prefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
      return normalized === normalizedRoot || normalized.startsWith(prefix);
    });
    if (!within) {
      throw new Error(`sync operation ${label} path escapes its confinement root: ${candidate}`);
    }
  };
  for (const operation of operations) {
    for (const mapping of operation.files) {
      confine(mapping.sourcePath, roots.sourceRoots, "source");
      confine(mapping.targetPath, roots.targetRoots, "target");
    }
  }
}

export interface PreparedSandboxManagedRuntime {
  spec: SandboxRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation). Empty when no additional sources
   * were requested.
   */
  additionalSourceDirs: Record<string, string>;
  /**
   * Each additional (referenced) project whose staging failed, paired with the
   * failure message. Per-project failure isolation keeps one project's failure
   * from aborting the run, so a failed project is absent from
   * `additionalSourceDirs` and present here. Empty when every requested project
   * staged, or when no additional sources were requested.
   */
  additionalSourceFailures: AdditionalSourceStagingFailure[];
  /** Durable merge inputs used to resume an outbound restore after host restart. */
  workspaceSyncSnapshot: {
    baseline: DirectorySnapshot;
    gitSnapshot: GitWorkspaceSnapshot | null;
  } | null;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

export type WorkspaceInboundMode =
  "host_current" | "durable_seed" | "adopt_remote";

/**
 * Controller-owned archives for replaying the exact pre-turn workspace into a
 * replacement sandbox. Paths are never sent to the provider as credentials or
 * persisted in database metadata.
 */
export interface WorkspaceDurableSeedPaths {
  workspaceArchivePath: string;
  workspaceArchiveSha256?: string;
  gitArchivePath?: string | null;
  gitArchiveSha256?: string | null;
}

/** One additional (referenced) project that failed to stage into the sandbox. */
export interface AdditionalSourceStagingFailure {
  projectId: string;
  error: string;
}

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

function buildDefaultExtractRuntimeAssetCommand(input: {
  remoteAssetDir: string;
  remoteAssetTar: string;
}): string {
  return `rm -rf ${shellQuote(input.remoteAssetDir)} && ` +
    `mkdir -p ${shellQuote(input.remoteAssetDir)} && ` +
    `tar -xf ${shellQuote(input.remoteAssetTar)} -C ${shellQuote(input.remoteAssetDir)} && ` +
    `rm -f ${shellQuote(input.remoteAssetTar)}`;
}

// Named builder (Security Condition C3): extract an uploaded workspace tarball
// into `workspaceRemoteDir`, then remove the tarball. When `wipeExceptNames` is
// present the target's direct children (except the preserved names) are removed
// before extraction (destroy-then-replace); when null the tarball is overlaid on
// top of the existing tree (e.g. a git overlay merge). Every path is
// shell-quoted; no untrusted value is concatenated into the shell (C1/C3).
function buildWorkspaceTarExtractCommand(input: {
  workspaceRemoteDir: string;
  remoteTar: string;
  wipeExceptNames: string[] | null;
}): string {
  // The wipe must also preserve any in-flight sync scratch tarball at the
  // workspace root. A concurrent referenced-project upload stages a scratch
  // tarball named `.paperclip-upload-<uuid>.tar` there. Without this preserve
  // term the wipe unlinks the in-flight tarball and the later extract fails.
  // The static pattern must agree with the daytona scratch prefix
  // `SCRATCH_PREFIX` in
  // `packages/plugins/sandbox-providers/daytona/src/file-sync.ts:80`.
  // The term is a static literal; `preserveFindArgs` shell-quotes it, so the
  // shell passes it to `find -name` as a pattern (Security Conditions C1/C3).
  const wipe = input.wipeExceptNames
    ? ` && find ${shellQuote(input.workspaceRemoteDir)} -mindepth 1 -maxdepth 1 ` +
      `${preserveFindArgs([...input.wipeExceptNames, ".paperclip-upload-*"])} -exec rm -rf -- {} +`
    : "";
  return (
    `mkdir -p ${shellQuote(input.workspaceRemoteDir)}${wipe} && ` +
    `tar -xf ${shellQuote(input.remoteTar)} -C ${shellQuote(input.workspaceRemoteDir)} && ` +
    `rm -f ${shellQuote(input.remoteTar)}`
  );
}

// Named builder (C3): remove paths deleted in the host git worktree from the
// sandbox workspace. Every path is shell-quoted; the caller supplies only
// already-confined relative paths from the git snapshot.
function buildRemoveDeletedPathsCommand(input: {
  remoteDir: string;
  deletedPaths: string[];
}): string {
  const quotedPaths = input.deletedPaths.map((entry) => shellQuote(entry)).join(" ");
  return `cd ${shellQuote(input.remoteDir)} && rm -rf -- ${quotedPaths}`;
}

function buildUniqueStagingPath(input: { targetPath: string; suffix: string }): string {
  return `${input.targetPath}${input.suffix}.${randomUUID()}`;
}

// The workspace stages under `<runtimeRootDir>/workspace-upload.tar` and, for a
// git-backed workspace, under `<runtimeRootDir>/git-workspace-upload.tar`. Each
// asset stages under `<runtimeRootDir>/<key>-upload.tar`, so an asset key equal to
// one of these stems resolves to the same remote archive path. Reserve the stems.
const RESERVED_RUNTIME_ASSET_KEYS = new Set(["workspace", "git-workspace"]);

// Reject an asset key before any path is built from it. An asset key becomes a
// remote directory (`<runtimeRootDir>/<key>`), a remote archive name
// (`<key>-upload.tar`), and a host temp file (`<key>.tar`). A path separator or
// `..` in the key escapes those roots. A reserved stem makes the asset archive
// share a path with the workspace archive; under concurrent sync the asset task
// and the workspace task then write or upload the same archive at the same time,
// which fails extraction nondeterministically or puts asset bytes in the
// workspace. Fail closed on both cases.
function assertRuntimeAssetKeyIsSafe(key: string): void {
  if (key.length === 0 || key.includes("/") || key.includes("\\") || key.includes("..")) {
    throw new Error(`sandbox runtime asset key is not a simple path segment: ${key}`);
  }
  if (RESERVED_RUNTIME_ASSET_KEYS.has(key)) {
    throw new Error(`sandbox runtime asset key collides with a reserved runtime archive name: ${key}`);
  }
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

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolveDigest, rejectDigest) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", rejectDigest);
    stream.on("end", () => resolveDigest(digest.digest("hex")));
  });
}

async function copyDurableSeedArchive(input: {
  sourcePath: string;
  targetPath: string;
  expectedSha256?: string | null;
}): Promise<void> {
  const source = await fs.lstat(input.sourcePath);
  if (source.isSymbolicLink() || !source.isFile()) {
    throw new Error("workspace_durable_seed_invalid");
  }
  if (
    input.expectedSha256 &&
    (await sha256File(input.sourcePath)) !== input.expectedSha256
  ) {
    throw new Error("workspace_durable_seed_digest_mismatch");
  }
  await fs.copyFile(input.sourcePath, input.targetPath);
}

async function persistDurableSeedArchive(input: {
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  const parent = path.dirname(input.targetPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("workspace_durable_seed_root_invalid");
  }
  const temporary = path.join(
    parent,
    `.${path.basename(input.targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.copyFile(input.sourcePath, temporary);
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, input.targetPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
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

export async function createTarballFromDirectory(input: {
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

  const stagedTargetPath = buildUniqueStagingPath({ targetPath, suffix: ".paperclip-copy" });
  await fs.rm(stagedTargetPath, { recursive: true, force: true }).catch(() => undefined);
  try {
    await fs.copyFile(sourcePath, stagedTargetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
      await fs.copyFile(sourcePath, stagedTargetPath);
    });
    await fs.chmod(stagedTargetPath, stats.mode);
    await fs.rename(stagedTargetPath, targetPath);
  } finally {
    await fs.rm(stagedTargetPath, { recursive: true, force: true }).catch(() => undefined);
  }
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

function toBuffer(bytes: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// Sum `bytesTransferred` over a `SandboxSyncResult`. The result crosses the
// plugin boundary, so a provider can return anything: guard each value and
// treat a missing, non-finite, or negative number as 0.
function sumSyncResultBytes(result: SandboxSyncResult): number {
  return result.operations.reduce((total, operation) => {
    const bytes = operation.bytesTransferred;
    return Number.isFinite(bytes) && bytes > 0 ? total + bytes : total;
  }, 0);
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

export function mergeExcludes(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function preserveFindArgs(entries: string[]): string {
  return entries.map((entry) => `! -name ${shellQuote(entry)}`).join(" ");
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
  syncWorkspace?: boolean;
  /** Selects authoritative host staging, exact durable-seed replay, or no-overwrite adoption. */
  workspaceInboundMode?: WorkspaceInboundMode;
  workspaceDurableSeed?: WorkspaceDurableSeedPaths;
  /** Durable snapshots supplied when reconstructing an interrupted restore. */
  workspaceBaseline?: DirectorySnapshot;
  workspaceGitSnapshot?: GitWorkspaceSnapshot | null;
  workspaceExclude?: string[];
  preserveAbsentOnRestore?: string[];
  assets?: SandboxManagedRuntimeAsset[];
  /**
   * Referenced (additional) projects to stage into the sandbox as plain,
   * read-only trees, each in its own isolated `project-<projectId>` directory.
   * Defaults to none, so a legacy/anchor-only call is behavior-identical.
   */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into writeFile/readFile.
  onProgress?: RuntimeProgressSink;
  onRuntimeProgress?: RuntimeStatusSink;
  // Optional host span runner for the workspace tarball build. When present, the
  // host builds both workspace tarballs inside one span named `pack`, so the
  // host pack time is visible under the `stage.sync` step. The default is a
  // no-op that keeps the current behavior and control flow. A throwing runner
  // never changes control flow (see `createRuntimeSpanRunner`).
  runtimeSpan?: RuntimeSpanRunner;
}): Promise<PreparedSandboxManagedRuntime> {
  const workspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const syncWorkspace = input.syncWorkspace !== false;
  const workspaceInboundMode = input.workspaceInboundMode ?? "host_current";
  const stageWorkspace =
    syncWorkspace && workspaceInboundMode !== "adopt_remote";
  const prepareWorkspaceSeed =
    syncWorkspace &&
    workspaceInboundMode === "adopt_remote" &&
    input.workspaceDurableSeed !== undefined;
  if (workspaceInboundMode === "durable_seed" && !input.workspaceDurableSeed) {
    throw new Error("workspace_durable_seed_missing");
  }

  // Reject any unsafe asset key before an archive path or an asset directory is
  // built from it. This runs before the git snapshot work so a bad key fails fast.
  for (const asset of input.assets ?? []) {
    assertRuntimeAssetKeyIsSafe(asset.key);
  }

  // Wrap a host-side staging sub-step or one scheduler task in its own span when
  // the caller injects a runtime span runner. The runner defaults to a no-op, so
  // a caller with no injected runner keeps the current control flow, and a
  // throwing runner never changes it (see `createRuntimeSpanRunner`). The two
  // pre-`pack` operations — the git enumeration and the baseline content-hash
  // walk — parent under the `stage.sync` step, so they stop showing up as a
  // hidden gap at the head of the step. Each inbound task (`stage.workspace`,
  // `stage.asset.<key>`, `stage.project.<id>`) and each outbound restore task
  // (`restore.workspace`, `restore.asset.<key>`) opens its own span, so two
  // concurrent tasks produce overlapping spans and the `pack` span nests under
  // `stage.workspace`. The outbound spans parent under the run's `sandbox.syncBack`
  // span, because the teardown runs the restore inside that span.
  const runStepSpan = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    input.runtimeSpan ? input.runtimeSpan(name, work) : work();

  // The git enumeration (`git status --ignored`, the HEAD diffs, `ls-files`).
  // It reads git's own bookkeeping to decide what to include/exclude, so it is
  // usually fast, but on a large working tree the `--ignored` walk is not free.
  const gitSnapshot = syncWorkspace
    ? input.workspaceGitSnapshot !== undefined
      ? input.workspaceGitSnapshot
      : await runStepSpan("snapshot.git", () =>
          readGitWorkspaceSnapshot(input.workspaceLocalDir),
        )
    : null;
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
  // The baseline "before" snapshot: a recursive walk of the whole workspace that
  // `lstat`s every entry and SHA-256-hashes every file's bytes. This is the
  // dominant cost in the pre-`pack` window — it reads the content of every
  // non-excluded file, serially — so it earns its own span.
  const baselineSnapshot = syncWorkspace
    ? (input.workspaceBaseline ??
      (await runStepSpan("snapshot.baseline", () =>
        captureDirectorySnapshot(input.workspaceLocalDir, {
          exclude: restoreExclude,
        }),
      )))
    : null;

  // Every inbound staging step delegates to the provider through `client.syncIn`:
  // the orchestrator no longer inlines `writeFile`+`run` or chooses a transport,
  // and there is no `usesCustomProvision` native-diversion gate. `syncIn` is
  // ALWAYS present in production — the command-managed client exposes a native
  // transport (Daytona/Kubernetes `uploadFiles` + provider-executed post-upload
  // commands) or a byte-identical base64-tar fallback that reproduces the prior
  // `writeFile`+`run` sequence. Require it explicitly so a misconfigured client
  // fails loud rather than silently skipping staging. `syncOut` stays optional
  // (native-only) with a tar fallback on the restore path below.
  const syncIn = input.client.syncIn;
  if (typeof syncIn !== "function") {
    throw new Error(
      "prepareSandboxManagedRuntime requires a client that exposes syncIn " +
        "(createCommandManagedRuntimeClient provides a native-or-fallback implementation).",
    );
  }
  const nativeSyncOut = typeof input.client.syncOut === "function";
  let syncOperationSeq = 0;
  // Opaque, ordered, non-sensitive operation tokens — never a caller/asset id.
  const nextSyncOperationId = () => `sync-op-${++syncOperationSeq}`;

  // Remote directory of each additional (referenced) project that stages
  // successfully, keyed by projectId. A project that fails to stage is absent.
  const additionalSourceDirs: Record<string, string> = {};
  // Each additional (referenced) project whose staging failed, paired with the
  // failure message. Per-project failure isolation keeps the run and the other
  // projects going; this list makes each failure a first-class, reported outcome.
  const additionalSourceFailures: AdditionalSourceStagingFailure[] = [];
  // Additional projects stage as plain trees. Drop the heavy build/cache dirs a
  // reference tree does not need, and `.git` — additional sources never carry
  // git-history semantics (anchor-only). Each project also drops its OWN
  // resolved Git-ignored paths (or keeps this fixed set as-is for a non-Git
  // source) — see `resolveReferencedSourceIgnore` and the per-project merge
  // below.
  const additionalSourceBaseExclude = mergeExcludes(SANDBOX_WORKSPACE_HEAVY_DIR_EXCLUDES, [".git"]);

  // Every delegated post-upload command (extract/wipe/remove-deleted/asset merge)
  // must run under the run-specific timeout (`spec.timeoutMs`), not the provider
  // sync client's default timeout — the two can differ, and before staging was
  // routed through `syncIn` each of these ran via
  // `client.run(cmd, { timeoutMs: spec.timeoutMs })`. When they mismatch, a
  // command left without a `timeoutMs` outlives (or is killed under) the wrong
  // limit. Stamp the run timeout onto every delegated command, preserving any
  // command that already carries its own explicit timeout.
  const withRunTimeout = (
    commands: SandboxPostUploadCommand[],
  ): SandboxPostUploadCommand[] =>
    commands.map((command) => ({
      ...command,
      timeoutMs: command.timeoutMs ?? input.spec.timeoutMs,
    }));

  await withTempDir("paperclip-sandbox-sync-", async (tempDir) => {
    const preservedNames = new Set([
      ".paperclip-runtime",
      ...(gitSnapshot ? [".git"] : []),
      ...(input.preserveAbsentOnRestore ?? []),
    ]);

    // Stage one source directory into an isolated remote subdirectory through the
    // unified `syncIn` seam. Both the workspace/asset tar path and the additional
    // (referenced) project path use it: build one `SandboxSyncOperation` from the
    // caller's `files` mappings (a host tarball as a single `file` mapping, or a
    // whole `directory` mapping), carry any extract/wipe/merge steps as ordered
    // `postUploadCommands`, confine the operation's source and target to their
    // own roots (fail-closed), and delegate to `syncIn` (native transfer, or the
    // base64-tar fallback). `finish` emits the terminal progress line.
    const stageConfinedSyncIn = async (params: {
      files: SandboxSyncFileMapping[];
      postUploadCommands?: SandboxPostUploadCommand[];
      sourceRoots: string[];
      targetRoots: string[];
      progressLabel: string;
      statusPhase: RuntimeStatusPhase;
      progressBytes: number;
    }): Promise<void> => {
      const operations: SandboxSyncOperation[] = [{
        operationId: nextSyncOperationId(),
        files: params.files,
        ...(params.postUploadCommands
          ? { postUploadCommands: withRunTimeout(params.postUploadCommands) }
          : {}),
      }];
      assertSyncOperationsConfined(operations, {
        sourceRoots: params.sourceRoots,
        targetRoots: params.targetRoots,
      });
      const upload = makeTransferProgress(
        input.onProgress,
        "Syncing",
        "to",
        params.progressLabel,
        { sink: input.onRuntimeProgress, phase: params.statusPhase },
      );
      const syncResult = await syncIn(operations);
      // Prefer the transport's own byte total. It is the real count for a
      // provider that has no host tarball to stat (a referenced project rides
      // a `directory` mapping). Fall back to the caller-supplied count when
      // the transport reports 0, so a provider that under-reports still
      // shows the host-known workspace total.
      const transferredBytes = sumSyncResultBytes(syncResult);
      const reportedBytes = transferredBytes > 0 ? transferredBytes : params.progressBytes;
      await upload.finish(reportedBytes, reportedBytes);
    };

    // Build the ordered inbound operation task list. Each task stages one inbound
    // operation from start to end: it packs the bytes, confines the mappings, and
    // uploads them. The shared scheduler starts the tasks. When the sync client
    // permits concurrency, the scheduler keeps at most SYNC_OPERATION_CONCURRENCY_LIMIT
    // tasks active. When the client does not permit concurrency, the scheduler runs
    // one task at a time in this order. The scheduler settles every started task
    // before it returns, so no upload outlives the coordinator and ACP never starts
    // before the barrier.
    const inboundTasks: Array<SyncOperationTask<void>> = [];
    // A required-flag list, one entry per task and index-aligned with inboundTasks.
    // The workspace and each asset are required operations: a rejection is fatal
    // after the barrier. Each referenced project is a nonfatal operation: its task
    // records its own failure and never rejects.
    const inboundTaskIsRequired: boolean[] = [];

    if (stageWorkspace || prepareWorkspaceSeed) {
      inboundTaskIsRequired.push(true);
      inboundTasks.push(() =>
        runStepSpan("stage.workspace", async () => {
          // A git-backed workspace and a plain workspace both stage through ONE
          // confined `syncIn` operation. A git-backed workspace carries TWO host tars —
          // the git-history clone and the working-tree overlay — as two `file` mappings
          // on the SAME operation, with their extract commands as ordered
          // `postUploadCommands`. One operation shares one mkdir, one confine guard, one
          // `uploadFiles`, and one rename exec, so the second `syncIn` round trip is
          // removed. Build the whole merged file set and command list BEFORE the confine
          // guard runs (inside `stageConfinedSyncIn`); never append a mapping after it.
          const workspaceFiles: SandboxSyncFileMapping[] = [];
          const workspacePostUploadCommands: SandboxPostUploadCommand[] = [];
          let workspaceUploadBytes = 0;

          // Build both host tarballs (the git-history tar and the workspace-overlay
          // tar) inside one host span named `pack`. This span makes the host pack
          // time visible under the `stage.sync` step, where it is otherwise a hidden
          // gap with no span. The transfer (`stageConfinedSyncIn`) runs after this
          // span, so `pack` measures only the host tar-build cost. The runner
          // defaults to a no-op, so a caller with no injected runner keeps the
          // current behavior and control flow.
          await runStepSpan("pack", async () => {
            // 1. git-history tar (git-backed workspace only). Both tar targets live under
            //    `runtimeRootDir` (`.paperclip-runtime/<adapterKey>`). The git extract
            //    wipes the target tree EXCEPT `.paperclip-runtime`, so the overlay tar,
            //    which sits under `.paperclip-runtime`, survives to run its own extract.
            if (gitSnapshot) {
              await emitRuntimeStatus(input.onRuntimeProgress, "git_sync", "Syncing git history to environment");
              const gitTarPath = path.join(tempDir, "git-workspace.tar");
              const remoteGitTar = path.posix.join(
                runtimeRootDir,
                "git-workspace-upload.tar",
              );
              if (workspaceInboundMode === "durable_seed") {
                const durableGitArchive =
                  input.workspaceDurableSeed?.gitArchivePath;
                if (!durableGitArchive) {
                  throw new Error("workspace_durable_seed_git_missing");
                }
                await copyDurableSeedArchive({
                  sourcePath: durableGitArchive,
                  targetPath: gitTarPath,
                  expectedSha256: input.workspaceDurableSeed?.gitArchiveSha256,
                });
              } else {
                await withShallowGitWorkspaceClone(
                  {
                    localDir: input.workspaceLocalDir,
                    snapshot: gitSnapshot,
                  },
                  async (cloneDir) => {
                    await createTarballFromDirectory({
                      localDir: cloneDir,
                      archivePath: gitTarPath,
                      exclude: [".paperclip-runtime"],
                    });
                  },
                );
                if (input.workspaceDurableSeed?.gitArchivePath) {
                  await persistDurableSeedArchive({
                    sourcePath: gitTarPath,
                    targetPath: input.workspaceDurableSeed.gitArchivePath,
                  });
                }
              }
              workspaceFiles.push({
                sourcePath: gitTarPath,
                targetPath: remoteGitTar,
                kind: "file",
                access: "rw",
                writablePath: workspaceRemoteDir,
              });
              workspacePostUploadCommands.push({
                command: buildWorkspaceTarExtractCommand({
                  workspaceRemoteDir,
                  remoteTar: remoteGitTar,
                  wipeExceptNames: [".paperclip-runtime"],
                }),
              });
              workspaceUploadBytes += (await fs.stat(gitTarPath)).size;
            }

            // 2. workspace-overlay tar. A git-backed overlay merges on top of the just
            //    extracted git tree (no wipe); a plain workspace wipes every child except
            //    the preserved names first. The extract runs AFTER the git extract.
            await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing workspace to environment");
            const workspaceTarPath = path.join(tempDir, "workspace.tar");
            if (workspaceInboundMode === "durable_seed") {
              await copyDurableSeedArchive({
                sourcePath: input.workspaceDurableSeed!.workspaceArchivePath,
                targetPath: workspaceTarPath,
                expectedSha256:
                  input.workspaceDurableSeed!.workspaceArchiveSha256,
              });
            } else {
              const workspaceArchiveDir = gitSnapshot
                ? path.join(tempDir, "workspace-overlay")
                : input.workspaceLocalDir;
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
              if (input.workspaceDurableSeed) {
                await persistDurableSeedArchive({
                  sourcePath: workspaceTarPath,
                  targetPath: input.workspaceDurableSeed.workspaceArchivePath,
                });
              }
            }
            const remoteWorkspaceTar = path.posix.join(
              runtimeRootDir,
              "workspace-upload.tar",
            );
            workspaceFiles.push({
              sourcePath: workspaceTarPath,
              targetPath: remoteWorkspaceTar,
              kind: "file",
              access: "rw",
              writablePath: workspaceRemoteDir,
            });
            workspacePostUploadCommands.push({
              command: buildWorkspaceTarExtractCommand({
                workspaceRemoteDir,
                remoteTar: remoteWorkspaceTar,
                wipeExceptNames: gitSnapshot ? null : [...preservedNames],
              }),
            });
            // 3. Optional remove-deleted-paths command runs LAST, after both extracts.
            if (gitSnapshot && gitSnapshot.deletedPaths.length > 0) {
              workspacePostUploadCommands.push({
                command: buildRemoveDeletedPathsCommand({
                  remoteDir: workspaceRemoteDir,
                  deletedPaths: gitSnapshot.deletedPaths,
                }),
              });
            }
            workspaceUploadBytes += (await fs.stat(workspaceTarPath)).size;
          });

          if (!stageWorkspace) return;

          // One confined `syncIn` for the whole merged workspace file set. The confine
          // guard covers every mapping BEFORE any bytes upload (fail-closed): a source
          // or target escape in EITHER tar mapping stops the upload of both.
          await stageConfinedSyncIn({
            files: workspaceFiles,
            postUploadCommands: workspacePostUploadCommands,
            sourceRoots: [tempDir],
            targetRoots: [runtimeRootDir],
            progressLabel: "workspace",
            statusPhase: "config_sync",
            progressBytes: workspaceUploadBytes,
          });
        }),
      );
    }

    for (const asset of input.assets ?? []) {
      inboundTaskIsRequired.push(true);
      inboundTasks.push(() =>
        runStepSpan(`stage.asset.${asset.key}`, async () => {
          await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing runtime assets to environment");
          const remoteAssetDir = path.posix.join(runtimeRootDir, asset.key);
          const remoteAssetTar = path.posix.join(runtimeRootDir, `${asset.key}-upload.tar`);
          // Every asset — default OR custom-provisioned (e.g. an adapter credential
          // merge) — rides one `syncIn` operation: the asset tar plus any staged
          // helper files as `files` mappings, and the extract/merge command as the
          // ordered post-upload command. There is no native-diversion gate; a
          // custom-provisioned asset's bytes now ride native `uploadFiles` and its
          // command runs as a provider-executed post-upload command.
          const assetTarPath = path.join(tempDir, `${asset.key}.tar`);
          await createTarballFromDirectory({
            localDir: asset.localDir,
            archivePath: assetTarPath,
            followSymlinks: asset.followSymlinks,
            exclude: asset.exclude,
          });
          const files: SandboxSyncFileMapping[] = [
            { sourcePath: assetTarPath, targetPath: remoteAssetTar, kind: "file", access: "rw", writablePath: remoteAssetDir },
          ];
          // Stage provision helper files (e.g. the merge scripts) into the temp dir
          // and map them alongside the asset tar so they ride the same native upload.
          for (const stageFile of asset.provision?.stageFiles ?? []) {
            const safeName = stageFile.name;
            if (/[\\/]|\.\.(\.|$)/.test(safeName) || safeName === "..") {
              throw new Error(`provision stageFile.name must be a simple basename, got: ${safeName}`);
            }
            const stageBytes = typeof stageFile.contents === "string"
              ? Buffer.from(stageFile.contents)
              : stageFile.contents;
            const stageHostPath = path.join(tempDir, `${asset.key}.stage.${safeName}`);
            await fs.writeFile(stageHostPath, stageBytes);
            // A stage helper file (for example a merge script) is a read-only input
            // that the provision command reads; the agent does not change it and does
            // not keep it. So it is `access: "ro"` and never joins the writable set.
            files.push({
              sourcePath: stageHostPath,
              targetPath: path.posix.join(runtimeRootDir, safeName),
              kind: "file",
              access: "ro",
            });
          }
          const postUploadCommand = asset.provision?.postUploadCommand?.({
            assetTarPath: remoteAssetTar,
            assetDir: remoteAssetDir,
            runtimeRootDir,
          }) ?? buildDefaultExtractRuntimeAssetCommand({ remoteAssetDir, remoteAssetTar });
          const assetTarSize = (await fs.stat(assetTarPath)).size;
          await stageConfinedSyncIn({
            files,
            postUploadCommands: [{ command: postUploadCommand }],
            sourceRoots: [tempDir],
            targetRoots: [runtimeRootDir],
            progressLabel: asset.key,
            statusPhase: "config_sync",
            progressBytes: assetTarSize,
          });
        }),
      );
    }

    // Stage each referenced (additional) project as a plain, read-only tree in
    // its OWN isolated remote directory (`project-<projectId>`). An additional
    // project rides one confined `syncIn` directory mapping — a native directory
    // transfer, or the base64-tar fallback — with source and target confined to
    // their own roots. No workspace, git-history, or `.paperclip-runtime`
    // semantics apply; those stay anchor-only. Per-project failure isolation: one
    // project's confinement or sync failure logs a warning and is skipped, and
    // the run plus the other projects continue. Only a project that stages
    // successfully appears in `additionalSourceDirs`.
    const additionalSourceList = input.additionalSources ?? [];
    // Record each referenced-project failure in its input-order slot. Slot order
    // keeps the failure list stable no matter the task completion order under
    // concurrency.
    const additionalFailureSlots: Array<AdditionalSourceStagingFailure | null> =
      additionalSourceList.map(() => null);
    additionalSourceList.forEach((source, sourceIndex) => {
      inboundTaskIsRequired.push(false);
      inboundTasks.push(() =>
        runStepSpan(`stage.project.${source.projectId}`, async () => {
          const { localPath, projectId, ignoreResolution } = source;
          const label = `project-${projectId}`;
          try {
            if (!path.posix.isAbsolute(localPath)) {
              throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
            }
            if (
              projectId.length === 0 ||
              projectId.includes("/") ||
              projectId.includes("\\") ||
              projectId.includes("..")
            ) {
              throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
            }
            // Fail closed: a project whose ignore resolution failed is not staged
            // at all. Shipping it with only the fixed heavy-directory excludes
            // would defeat the resolution's purpose.
            if (ignoreResolution.kind === "failed") {
              throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
            }
            const remoteProjectDir = path.posix.join(runtimeRootDir, label);
            const exclude = mergeExcludes(
              additionalSourceBaseExclude,
              referencedSourceIgnoreExcludeEntries(ignoreResolution),
            );
            await emitRuntimeStatus(input.onRuntimeProgress, "config_sync", "Syncing referenced project to environment");
            await stageConfinedSyncIn({
              files: [{
                sourcePath: localPath,
                targetPath: remoteProjectDir,
                kind: "directory",
                exclude,
                access: "ro",
              }],
              sourceRoots: [localPath],
              targetRoots: [remoteProjectDir],
              progressLabel: label,
              statusPhase: "config_sync",
              progressBytes: 0,
            });
            additionalSourceDirs[projectId] = remoteProjectDir;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Record the failure as a first-class per-project outcome so the run can count it in the
            // requested-vs-synced accounting and surface the reason on the run result and the run log.
            // The structured slot carries the reason, so no `console.warn` line is needed here.
            additionalFailureSlots[sourceIndex] = { projectId, error: message };
          }
        }),
      );
    });

    // Run every inbound operation through the shared scheduler. It starts the
    // tasks under the client's concurrency permission and the bound, and it
    // settles every started task before it returns. This is the startup barrier:
    // the coordinator returns only after every upload settles.
    const inboundResults = await scheduleSyncOperations(
      inboundTasks,
      input.client.allowConcurrentSyncOperations === true,
      SYNC_OPERATION_CONCURRENCY_LIMIT,
    );

    // Collect the referenced-project failures in stable input order.
    for (const failure of additionalFailureSlots) {
      if (failure) {
        additionalSourceFailures.push(failure);
      }
    }

    // Select a fatal failure in stable operation order. The workspace comes first,
    // then each asset. A referenced-project task never rejects, so a nonfatal
    // outcome never appears here. Raise the first required rejection, so two
    // required failures raise the earlier one.
    for (let index = 0; index < inboundResults.length; index += 1) {
      const result = inboundResults[index];
      if (inboundTaskIsRequired[index] && result.status === "rejected") {
        throw result.reason;
      }
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
    additionalSourceDirs,
    additionalSourceFailures,
    workspaceSyncSnapshot:
      syncWorkspace && baselineSnapshot
        ? { baseline: baselineSnapshot, gitSnapshot }
        : null,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      const restoreSink = onProgress ?? input.onProgress;

      // Build the ordered outbound restore task list. Each task runs one
      // restore from start to end: the workspace restore, or one asset restore.
      // The shared scheduler starts the tasks. When the sync client permits
      // concurrency, the scheduler keeps at most SYNC_OPERATION_CONCURRENCY_LIMIT
      // tasks active. When the client does not permit concurrency, the scheduler
      // runs one task at a time in this order. The scheduler settles every
      // started task before it returns, so lease teardown never starts while an
      // outbound restore task still writes host data.
      const outboundTasks: Array<SyncOperationTask<void>> = [];

      // The workspace restore task runs only when the run syncs the workspace.
      // The task exports the sandbox git history (git-backed workspace), reads
      // the sandbox workspace back, and merges it into the host workspace root.
      // The merge is the only outbound write inside the host workspace root.
      // Every other task writes a disjoint host target: an asset restore writes
      // its own store outside the workspace root. So the workspace task and the
      // asset tasks share one parallel set. Keep any future asset that must write
      // inside the host workspace root out of this set, and run it after the
      // merge. Each task gets its own restore temp directory, so two concurrent
      // tasks never share scratch state.
      if (syncWorkspace) {
        outboundTasks.push(() =>
          runStepSpan("restore.workspace", async () => {
            await withTempDir("paperclip-sandbox-restore-", async (tempDir) => {
              let importedRef: string | null = null;
              let importedHead: string | null = null;
              let remoteWorkspaceStatus = "dirty";
              try {
                if (gitSnapshot) {
                  await emitRuntimeStatus(input.onRuntimeProgress, "export", "Exporting git changes from environment");
                  importedRef = createImportedGitRef("sandbox");
                  const remoteGitBundle = path.posix.join(runtimeRootDir, "git-delta.bundle");
                  const remoteWorkspaceStatusPath = path.posix.join(runtimeRootDir, "workspace-status.txt");
                  const exportRef = createRemoteGitExportRef("sandbox");
                  const localBundlePath = path.join(tempDir, "git-delta.bundle");

                  // Export the sandbox history and import it into the host workspace.
                  // The delta bundle assumes the host holds the bundle's boundary
                  // commit; when the host has been reset far enough that it does not,
                  // the import fails on a missing prerequisite. In that case re-export
                  // a full, self-contained bundle from the still-live sandbox rather
                  // than discard the completed run.
                  const exportAndImport = async (forceFullBundle: boolean): Promise<string> => {
                    await input.client.run(
                      `sh -c ${shellQuote(buildRemoteGitDeltaBundleScript({
                        remoteDir: workspaceRemoteDir,
                        baseSha: gitSnapshot.headCommit,
                        exportRef,
                        bundlePath: remoteGitBundle,
                        statusPath: forceFullBundle ? undefined : remoteWorkspaceStatusPath,
                        forceFullBundle,
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
                    if (nativeSyncOut) {
                      // Native outbound: the provider copies the bundle straight from
                      // the sandbox into the host restore temp directory. This maps to
                      // one `kind: "file"` mapping. The host does not buffer the full
                      // bundle in RAM and does not move the bytes through the base64
                      // read loop. The git import step below reads the bundle from
                      // `localBundlePath`. The provider transfer reports its own byte
                      // total, so the "Exporting git history" progress still degrades to
                      // start-and-finish (mirrors the workspace restore below), but the
                      // finish line carries the real transferred byte count.
                      const operations: SandboxSyncOperation[] = [{
                        operationId: nextSyncOperationId(),
                        files: [{
                          sourcePath: remoteGitBundle,
                          targetPath: localBundlePath,
                          kind: "file",
                        }],
                      }];
                      assertSyncOperationsConfined(operations, {
                        sourceRoots: [runtimeRootDir],
                        targetRoots: [tempDir],
                      });
                      const syncResult = await input.client.syncOut!(operations);
                      const transferredBytes = sumSyncResultBytes(syncResult);
                      await gitExport.finish(transferredBytes, transferredBytes);
                    } else {
                      const bundleBytes = await input.client.readFile(remoteGitBundle, gitExport.options);
                      const bundleBuffer = toBuffer(bundleBytes);
                      await gitExport.finish(bundleBuffer.byteLength, bundleBuffer.byteLength);
                      await fs.writeFile(localBundlePath, bundleBuffer);
                    }
                    await input.client.remove(remoteGitBundle).catch(() => undefined);
                    if (!forceFullBundle) {
                      remoteWorkspaceStatus = await input.client.readFile(remoteWorkspaceStatusPath)
                        .then((bytes) => toBuffer(bytes).toString("utf8").trim())
                        .catch(() => "dirty");
                      remoteWorkspaceStatus = remoteWorkspaceStatus === "clean" ? "clean" : "dirty";
                      await input.client.remove(remoteWorkspaceStatusPath).catch(() => undefined);
                    }
                    return fetchGitBundleIntoLocalRef({
                      localDir: input.workspaceLocalDir,
                      bundlePath: localBundlePath,
                      exportRef,
                      importedRef: importedRef!,
                      baseSha: gitSnapshot.headCommit,
                    });
                  };

                  try {
                    importedHead = await exportAndImport(false);
                  } catch (error) {
                    if (!isMissingGitPrerequisiteError(error)) throw error;
                    importedHead = await exportAndImport(true);
                  }
                }

                await emitRuntimeStatus(input.onRuntimeProgress, "restore", "Restoring workspace from environment");
                const extractedDir = path.join(tempDir, "workspace");
                if (nativeSyncOut) {
                  // Native outbound: the provider materializes the sandbox workspace into
                  // a fresh host directory. It is a clean destroy-then-replace into a
                  // temp dir the orchestrator just created, so it maps exactly to a
                  // generic directory file mapping; the host-side baseline merge below is
                  // unchanged. The provider transfer reports its own byte total, so the
                  // finish line carries the real transferred byte count.
                  const operations: SandboxSyncOperation[] = [{
                    operationId: nextSyncOperationId(),
                    files: [{
                      sourcePath: workspaceRemoteDir,
                      targetPath: extractedDir,
                      kind: "directory",
                      exclude: restoreExclude,
                    }],
                  }];
                  assertSyncOperationsConfined(operations, {
                    sourceRoots: [workspaceRemoteDir],
                    targetRoots: [extractedDir],
                  });
                  await fs.mkdir(extractedDir, { recursive: true });
                  const workspaceRestore = makeTransferProgress(
                    restoreSink,
                    "Restoring",
                    "from",
                    "workspace",
                    { sink: input.onRuntimeProgress, phase: "restore" },
                  );
                  const syncResult = await input.client.syncOut!(operations);
                  const transferredBytes = sumSyncResultBytes(syncResult);
                  await workspaceRestore.finish(transferredBytes, transferredBytes);
                } else {
                  const remoteWorkspaceTar = path.posix.join(runtimeRootDir, "workspace-download.tar");
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
                  await fs.writeFile(localArchivePath, archiveBuffer);
                  await extractTarballToDirectory({
                    archivePath: localArchivePath,
                    localDir: extractedDir,
                  });
                }
                const gitHeadToIntegrate = importedHead;
                await mergeDirectoryWithBaseline({
                  baseline: baselineSnapshot!,
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
              } finally {
                await emitRuntimeStatus(input.onRuntimeProgress, "finalize", "Finalizing workspace");
                if (importedRef) {
                  await deleteLocalGitRef({ localDir: input.workspaceLocalDir, ref: importedRef });
                }
              }
            });
          }),
        );
      }

      // One restore task per asset that has a teardown contribution. Each task
      // reads its asset back through `readFile` and writes a disjoint host
      // target. Each task gets its own restore temp directory.
      for (const asset of input.assets ?? []) {
        if (!asset.restore) continue;
        const assetRestore = asset.restore;
        const assetKey = asset.key;
        outboundTasks.push(() =>
          runStepSpan(`restore.asset.${assetKey}`, async () => {
            await withTempDir("paperclip-sandbox-restore-", async (tempDir) => {
              await assetRestore({
                assetDir: path.posix.join(runtimeRootDir, assetKey),
                readFile: async (remotePath) => toBuffer(await input.client.readFile(remotePath)),
                tempDir,
              });
            });
          }),
        );
      }

      // Run every outbound restore through the shared scheduler. It starts the
      // tasks under the client concurrency permission and the bound, and it
      // settles every started task before it returns. This is the teardown
      // barrier.
      const outboundResults = await scheduleSyncOperations(
        outboundTasks,
        input.client.allowConcurrentSyncOperations === true,
        SYNC_OPERATION_CONCURRENCY_LIMIT,
      );

      // Every outbound restore is a required operation: a rejection is fatal.
      // The workspace comes first, then each asset in order. Raise the first
      // rejection in stable task order, so two failures raise the earlier one.
      for (const result of outboundResults) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    },
  };
}
