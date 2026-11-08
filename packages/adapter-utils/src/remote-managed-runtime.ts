import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot, type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_LOCK_GRACE_MS = 30 * 60 * 1000;

interface StableWorkspaceLock {
  lockDir: string;
  acquired: boolean;
}

// `mkdir` is the atomic lock; the owner file lets another run tell a live holder from a dead one.
async function tryMkdirLock(spec: SshRemoteExecutionSpec, lockDir: string, runId: string): Promise<{ acquired: boolean; owner: string }> {
  const result = await runSshCommand(
    spec,
    `mkdir -p ${shellQuote(path.posix.dirname(lockDir))} && if mkdir ${shellQuote(lockDir)} 2>/dev/null; then ` +
      `printf 'runId=%s\nstartedAt=%s\n' ${shellQuote(runId)} ${Date.now()} > ${shellQuote(`${lockDir}/owner`)}; echo ACQUIRED; ` +
      `else echo BUSY; cat ${shellQuote(`${lockDir}/owner`)} 2>/dev/null; ` +
      `echo "mtime=$(stat -c %Y ${shellQuote(lockDir)} 2>/dev/null || stat -f %m ${shellQuote(lockDir)} 2>/dev/null)"; echo "now=$(date +%s)"; fi`,
  );
  const lines = result.stdout.split("\n").map((line) => line.trim());
  if (lines[0] === "ACQUIRED") return { acquired: true, owner: "" };
  return { acquired: false, owner: result.stdout };
}

// Replaces a stale lock in one remote command, under a short `<lock>.reap` mutex, and only while the owner
// is still the one we judged stale. A bare `rm -rf` after reading the owner could delete a lock that
// another run took in between.
async function takeOverStaleLock(spec: SshRemoteExecutionSpec, lockDir: string, runId: string, observedOwnerRunId: string): Promise<boolean> {
  const lock = shellQuote(lockDir);
  const reap = shellQuote(`${lockDir}.reap`);
  const ownerFile = shellQuote(`${lockDir}/owner`);
  const stillObserved = observedOwnerRunId
    ? `grep -qx ${shellQuote(`runId=${observedOwnerRunId}`)} ${ownerFile} 2>/dev/null`
    : `[ ! -s ${ownerFile} ]`;
  const result = await runSshCommand(
    spec,
    `if [ -n "$(find ${reap} -maxdepth 0 -mmin +5 2>/dev/null)" ]; then rmdir ${reap} 2>/dev/null; fi; ` +
      `if mkdir ${reap} 2>/dev/null; then ` +
      `if ${stillObserved} && rm -rf ${lock} && mkdir ${lock} 2>/dev/null; then ` +
      `printf 'runId=%s\nstartedAt=%s\n' ${shellQuote(runId)} ${Date.now()} > ${ownerFile}; echo ACQUIRED; else echo BUSY; fi; ` +
      `rmdir ${reap} 2>/dev/null; else echo BUSY; fi`,
  );
  return result.stdout.trim().split("\n")[0] === "ACQUIRED";
}

async function acquireStableWorkspaceLock(input: {
  spec: SshRemoteExecutionSpec;
  baseDir: string;
  executionWorkspaceId: string;
  runId: string;
  timeoutSec?: number;
  onProgress?: RuntimeProgressSink;
}): Promise<StableWorkspaceLock> {
  const lockDir = path.posix.join(input.baseDir, ".paperclip-runtime", "workspaces", input.executionWorkspaceId, "lock");
  const first = await tryMkdirLock(input.spec, lockDir, input.runId);
  if (first.acquired) return { lockDir, acquired: true };

  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(first.owner)?.[1]?.trim() ?? "";
  const ownerRunId = field("runId");
  const startedAt = Number(field("startedAt"));
  const mtime = Number(field("mtime"));
  const now = Number(field("now"));
  let stale: boolean;
  if (ownerRunId && input.spec.isRunActive) {
    stale = !(await input.spec.isRunActive(ownerRunId).catch(() => true));
  } else {
    const timeoutMs = input.timeoutSec && input.timeoutSec > 0 ? input.timeoutSec * 1000 : 0;
    const ageMs = Number.isFinite(startedAt) && startedAt > 0
      ? Date.now() - startedAt
      : Number.isFinite(mtime) && Number.isFinite(now) && mtime > 0 ? (now - mtime) * 1000 : 0;
    stale = ageMs > timeoutMs + STALE_LOCK_GRACE_MS;
  }
  if (stale) {
    if (await takeOverStaleLock(input.spec, lockDir, input.runId, ownerRunId)) return { lockDir, acquired: true };
  }
  await input.onProgress?.(
    `[paperclip] stable remote folder busy (owner ${(ownerRunId || "unknown").replace(/[^A-Za-z0-9_-]/g, "?")}); using per-run folder\n`,
  );
  return { lockDir, acquired: false };
}

// Only the owner removes the lock, so a late finally never frees a lock another run took over.
async function releaseStableWorkspaceLock(spec: SshRemoteExecutionSpec, lockDir: string, runId: string): Promise<void> {
  await runSshCommand(
    spec,
    `grep -qx ${shellQuote(`runId=${runId}`)} ${shellQuote(`${lockDir}/owner`)} 2>/dev/null && rm -rf ${shellQuote(lockDir)}; true`,
  );
}

/** A stable workspace folder is swept when its last restore was ok and it has been unused this long. */
export const STABLE_WORKSPACE_SWEEP_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const LAST_RESTORE_MARKER = ".paperclip-last-restore";
const RUN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeRemoteBaseDir(baseDir: string): void {
  if (!path.posix.isAbsolute(baseDir) || /[\0\n]/.test(baseDir) || baseDir.split("/").includes("..")) {
    throw new Error(`remote base directory is not a safe absolute path: ${JSON.stringify(baseDir)}`);
  }
}

// Shell guard shared by every remote removal: the runtime root and its parent folder must be real
// directories, so a symlink planted in the workspace never redirects an `rm -rf` outside it.
function remoteRuntimeGuard(baseDir: string, subDir: "workspaces" | "runs"): string {
  const runtime = shellQuote(path.posix.join(baseDir, ".paperclip-runtime"));
  const parent = shellQuote(path.posix.join(baseDir, ".paperclip-runtime", subDir));
  return `{ [ -d ${runtime} ] && [ ! -L ${runtime} ] && [ -d ${parent} ] && [ ! -L ${parent} ]; }`;
}

// A materialised skill keeps its source's read-only mode, and `rm -rf` cannot empty a read-only
// directory. Owner-write first. `chmod -R` (no -L/-H) does not follow symlinks inside a tree, but it
// does follow one given as an argument, so each path is skipped when it is itself a symlink
// (`rm -rf` then removes just the link).
function makeWritableThenRemove(...quotedPaths: string[]): string {
  const paths = quotedPaths.join(" ");
  return `for p in ${paths}; do [ -L "$p" ] || chmod -R u+w "$p" 2>/dev/null; done; rm -rf ${paths}`;
}

// Deletes everything but the lock first, then the lock, so a run starting meanwhile sees it busy.
function removeLockedFolderScript(dir: string): string {
  const quoted = shellQuote(dir);
  return `chmod -R u+w ${quoted} 2>/dev/null; find ${quoted} -mindepth 1 -maxdepth 1 ! -name lock -exec rm -rf {} + ; rm -rf ${shellQuote(`${dir}/lock`)}; rmdir ${quoted} 2>/dev/null; true`;
}

export type StableWorkspaceRemoval = "removed" | "absent" | "locked" | "unsafe";

/**
 * Removes `<baseDir>/.paperclip-runtime/workspaces/<id>` on an SSH host, unless a run holds its lock.
 * Throws for a non-UUID id or an unsafe base directory; reports "unsafe" for a symlinked folder.
 */
export async function removeStableSshWorkspaceFolder(
  spec: SshRemoteExecutionSpec,
  baseDir: string,
  executionWorkspaceId: string,
): Promise<StableWorkspaceRemoval> {
  if (!UUID_PATTERN.test(executionWorkspaceId)) {
    throw new Error(`execution workspace id is not a UUID: ${JSON.stringify(executionWorkspaceId)}`);
  }
  assertSafeRemoteBaseDir(baseDir);
  const dir = path.posix.join(baseDir, ".paperclip-runtime", "workspaces", executionWorkspaceId);
  const quoted = shellQuote(dir);
  const result = await runSshCommand(
    spec,
    `if ! ${remoteRuntimeGuard(baseDir, "workspaces")}; then ` +
      `if [ -L ${shellQuote(path.posix.join(baseDir, ".paperclip-runtime"))} ] || [ -L ${shellQuote(path.posix.dirname(dir))} ]; then echo UNSAFE; else echo ABSENT; fi; ` +
      `elif [ -L ${quoted} ]; then echo UNSAFE; elif [ ! -d ${quoted} ]; then echo ABSENT; ` +
      `elif mkdir ${shellQuote(`${dir}/lock`)} 2>/dev/null; then ${removeLockedFolderScript(dir)}; echo REMOVED; ` +
      `else echo LOCKED; fi`,
  );
  switch (result.stdout.trim().split("\n").pop()) {
    case "REMOVED": return "removed";
    case "LOCKED": return "locked";
    case "UNSAFE": return "unsafe";
    default: return "absent";
  }
}

// Removes folders other runs left behind: unlocked, last restore ok, marker older than the sweep age.
async function sweepStaleStableWorkspaces(spec: SshRemoteExecutionSpec, baseDir: string, exceptId: string): Promise<void> {
  assertSafeRemoteBaseDir(baseDir);
  const root = path.posix.join(baseDir, ".paperclip-runtime", "workspaces");
  const minutes = Math.floor(STABLE_WORKSPACE_SWEEP_AFTER_MS / 60_000);
  await runSshCommand(
    spec,
    `if ${remoteRuntimeGuard(baseDir, "workspaces")}; then for d in ${shellQuote(root)}/*/; do d="\${d%/}"; id="\${d##*/}"; ` +
      `[ "$id" = ${shellQuote(exceptId)} ] && continue; [ -L "$d" ] && continue; ` +
      `printf '%s' "$id" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || continue; ` +
      `m="$d/${LAST_RESTORE_MARKER}"; [ -f "$m" ] && [ ! -L "$m" ] && grep -q '^ok' "$m" || continue; ` +
      `[ -n "$(find "$m" -maxdepth 0 -mmin +${minutes} 2>/dev/null)" ] || continue; ` +
      `if mkdir "$d/lock" 2>/dev/null; then ${removeLockedFolderScript("$d").replace(/'\$d'/g, '"$d"').replace(/'\$d\/lock'/g, '"$d/lock"')}; fi; done; fi; true`,
  );
}

async function markStableWorkspaceRestore(spec: SshRemoteExecutionSpec, workspaceDir: string, ok: boolean): Promise<void> {
  const marker = shellQuote(path.posix.join(path.posix.dirname(workspaceDir), LAST_RESTORE_MARKER));
  await runSshCommand(spec, `printf '%s %s\n' ${ok ? "ok" : "failed"} "$(date +%s)" > ${marker}`);
}

// Removes `runs/<runId>` (or only its runtime assets, which hold bearer tokens) after the restore.
async function cleanupRemoteRunFolder(
  spec: SshRemoteExecutionSpec,
  baseDir: string,
  runId: string,
  keep: { dir: string } | null,
): Promise<void> {
  if (!RUN_ID_SEGMENT_PATTERN.test(runId)) return;
  assertSafeRemoteBaseDir(baseDir);
  const runDir = path.posix.join(baseDir, ".paperclip-runtime", "runs", runId);
  const quotedRun = shellQuote(runDir);
  // A kept per-run workspace holds its own runtime assets under `workspace/.paperclip-runtime`.
  const script = keep
    ? makeWritableThenRemove(shellQuote(path.posix.join(keep.dir, ".paperclip-runtime")), shellQuote(path.posix.join(runDir, "runtime")))
    : makeWritableThenRemove(quotedRun);
  await runSshCommand(spec, `if ${remoteRuntimeGuard(baseDir, "runs")} && [ ! -L ${quotedRun} ]; then ${script}; fi; true`);
}

const SSH_COPY_BACK_DEPENDENCY_EXCLUDES = ["node_modules", "node_modules/*", "*/node_modules", "*/node_modules/*"];

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  /** Execution workspace id; keys the stable remote folder when `spec.remoteWorkspaceKey` is "execution_workspace". */
  executionWorkspaceId?: string | null;
  /** Adapter timeout; a lock older than this plus 30 minutes is stale when no `spec.isRunActive` exists. */
  timeoutSec?: number;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const syncWorkspace = input.syncWorkspace !== false;
  const stableId =
    syncWorkspace && input.spec.remoteWorkspaceKey === "execution_workspace" && input.executionWorkspaceId &&
    UUID_PATTERN.test(input.executionWorkspaceId)
      ? input.executionWorkspaceId
      : null;
  const stableLock = stableId
    ? await acquireStableWorkspaceLock({
        spec: input.spec,
        baseDir: baseWorkspaceRemoteDir,
        executionWorkspaceId: stableId,
        runId: input.runId,
        timeoutSec: input.timeoutSec,
        onProgress: input.onProgress,
      })
    : null;
  const cleanupRun = (keep: { dir: string } | null) =>
    cleanupRemoteRunFolder(input.spec, baseWorkspaceRemoteDir, input.runId, keep).catch((error) => {
      console.warn(`[paperclip] Failed to remove remote run folder for ${input.runId}. ${String(error)}`);
    });
  if (stableId) {
    await sweepStaleStableWorkspaces(input.spec, baseWorkspaceRemoteDir, stableId).catch((error) => {
      console.warn(`[paperclip] Remote workspace sweep failed. ${String(error)}`);
    });
  }
  const releaseStableLock = async () => {
    if (stableLock?.acquired) await releaseStableWorkspaceLock(input.spec, stableLock.lockDir, input.runId).catch(() => undefined);
  };
  const stableWorkspaceDir = stableLock?.acquired
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "workspaces", stableId!, "workspace")
    : null;
  const workspaceRemoteDir = !syncWorkspace
    ? baseWorkspaceRemoteDir
    : stableWorkspaceDir ??
      path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId, "workspace");
  // A stable workspace folder is shared across runs, so runtime assets stay per run beside it.
  const runtimeRootDir = stableWorkspaceDir
    ? path.posix.join(baseWorkspaceRemoteDir, ".paperclip-runtime", "runs", input.runId, "runtime", input.adapterKey)
    : path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  try {
    return await prepareLockedRemoteManagedRuntime();
  } catch (error) {
    // Keep a per-run workspace: the preparation did not finish, so nothing proves it was restored.
    await cleanupRun(syncWorkspace && !stableWorkspaceDir ? { dir: workspaceRemoteDir } : null);
    await releaseStableLock();
    throw error;
  }

  async function prepareLockedRemoteManagedRuntime(): Promise<PreparedRemoteManagedRuntime> {

  const preparedWorkspace = syncWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
      })
    : null;
  const projectRepositories = preparedWorkspace?.repositories ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.gitBacked
          ? [
              ...GIT_ARCHIVE_EXCLUDES,
              ".paperclip-runtime",
              ...(projectRepositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : preparedWorkspace.excludedPaths ?? []),
            ]
          : [".paperclip-runtime", ...(preparedWorkspace.excludedPaths ?? []), ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])],
      })
    : null;
  const repositoryBaselines: Array<{ path: string; baselineSnapshot: DirectorySnapshot }> = [];
  for (const repository of projectRepositories) {
    repositoryBaselines.push({
      path: repository,
      baselineSnapshot: await captureDirectorySnapshot(path.join(input.workspaceLocalDir, repository), {
        exclude: [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"],
      }),
    });
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
      });
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
        repositories: repositoryBaselines,
      });
    }
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
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
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      let restored = false;
      try {
        if (preparedWorkspace && baselineSnapshot) {
          await restoreWorkspaceFromSshExecution({
            spec: input.spec,
            localDir: input.workspaceLocalDir,
            remoteDir: workspaceRemoteDir,
            baselineSnapshot,
            restoreGitHistory: preparedWorkspace.gitBacked,
            onProgress,
            repositories: repositoryBaselines,
          });
        }
        for (const asset of input.assets ?? []) {
          if (!asset.restore) continue;
          await asset.restore({
            assetDir: path.posix.join(runtimeRootDir, asset.key),
            readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
          });
        }
        restored = true;
      } finally {
        if (stableWorkspaceDir) {
          await markStableWorkspaceRestore(input.spec, stableWorkspaceDir, restored).catch(() => undefined);
        }
        // A per-run workspace is removed after a good restore only; assets (bearer tokens) always.
        await cleanupRun(syncWorkspace && !stableWorkspaceDir && !restored ? { dir: workspaceRemoteDir } : null);
        await releaseStableLock();
      }
    },
  };
  }
}
