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
import { acquireKeyedDirectoryMergeLock } from "./workspace-restore-merge.js";
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

export interface RemoteTaskWorkspaceIdentity {
  companyId: string;
  agentId: string;
  issueId: string;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each referenced (additional) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  /**
   * Present when the workspace was realized at a stable per-task directory
   * (`.paperclip-runtime/tasks/<companyId>/<agentId>/<issueId>/workspace`)
   * instead of the legacy per-run directory. The directory persists across
   * runs of the same task so sessioned tools can resume in place; the
   * prepare/execute/restore cycle for the same task is serialized by a
   * keyed directory merge lock released by `restoreWorkspace` (and on any
   * preparation error).
   */
  taskWorkspaceIdentity: RemoteTaskWorkspaceIdentity | null;
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

function requireTaskWorkspaceSegment(value: unknown, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    trimmed.length === 0 ||
    trimmed !== value ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    throw new Error(`stable task workspace ${field} is not a simple path segment: ${String(value)}`);
  }
  return trimmed;
}

function buildStableTaskWorkspaceRemoteDir(
  baseRemoteDir: string,
  identity: RemoteTaskWorkspaceIdentity,
): string {
  return path.posix.join(
    baseRemoteDir,
    ".paperclip-runtime",
    "tasks",
    identity.companyId,
    identity.agentId,
    identity.issueId,
    "workspace",
  );
}

function buildStableTaskWorkspaceLockKey(
  spec: SshRemoteExecutionSpec,
  workspaceRemoteDir: string,
): string {
  return `stable-task-workspace:${spec.host}:${spec.port}:${spec.username}:${workspaceRemoteDir}`;
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  /**
   * Opt in to a stable per-task remote workspace directory keyed by
   * (companyId, agentId, issueId) instead of the legacy per-run directory.
   * The directory persists across runs of the same task; runtime assets
   * under the workspace's `.paperclip-runtime` subtree survive the per-run
   * workspace clean, so sessioned tools (for example OpenCode with its
   * session database under HOME) can resume in place. The whole
   * prepare/execute/restore cycle for the same task is serialized by a
   * keyed directory merge lock; a concurrent run of the same task fails
   * fast with a recoverable lock-timeout error instead of silently
   * clobbering the shared directory.
   */
  taskWorkspace?: RemoteTaskWorkspaceIdentity;
  /**
   * Test seam only: overrides how long the stable-workspace cycle lock waits
   * before reporting a timeout. Production callers must omit it and keep the
   * real budget.
   */
  taskWorkspaceLockWaitMs?: number;
  syncWorkspace?: boolean;
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
  const taskWorkspaceIdentity = input.taskWorkspace
    ? {
        companyId: requireTaskWorkspaceSegment(input.taskWorkspace.companyId, "companyId"),
        agentId: requireTaskWorkspaceSegment(input.taskWorkspace.agentId, "agentId"),
        issueId: requireTaskWorkspaceSegment(input.taskWorkspace.issueId, "issueId"),
      }
    : null;
  const workspaceRemoteDir = syncWorkspace
    ? taskWorkspaceIdentity
      ? buildStableTaskWorkspaceRemoteDir(baseWorkspaceRemoteDir, taskWorkspaceIdentity)
      : path.posix.join(
          baseWorkspaceRemoteDir,
          ".paperclip-runtime",
          "runs",
          input.runId,
          "workspace",
        )
    : baseWorkspaceRemoteDir;
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);

  // The stable workspace is shared state across runs of the same task: hold
  // the cycle lock from the first remote mutation until the restore (or the
  // preparation error path) completes. Legacy per-run workspaces are already
  // disjoint, so they keep the lock-free behavior.
  const releaseCycleLock = taskWorkspaceIdentity
    ? await acquireKeyedDirectoryMergeLock(
        buildStableTaskWorkspaceLockKey(input.spec, workspaceRemoteDir),
        "task_workspace_cycle",
        input.taskWorkspaceLockWaitMs,
      )
    : null;
  try {
    return await prepareRemoteManagedRuntimeLocked({
      ...input,
      taskWorkspaceIdentity,
      workspaceRemoteDir,
      runtimeRootDir,
      releaseCycleLock,
    });
  } catch (error) {
    await releaseCycleLock?.();
    throw error;
  }
}

async function prepareRemoteManagedRuntimeLocked(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  taskWorkspaceIdentity: RemoteTaskWorkspaceIdentity | null;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  releaseCycleLock: (() => Promise<void>) | null;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  additionalSources?: SandboxAdditionalSource[];
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const workspaceRemoteDir = input.workspaceRemoteDir;
  const runtimeRootDir = input.runtimeRootDir;
  const releaseCycleLock = input.releaseCycleLock;
  const syncWorkspace = input.syncWorkspace !== false;

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
    try {
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
    } finally {
      await releaseCycleLock?.();
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
    taskWorkspaceIdentity: input.taskWorkspaceIdentity,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
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
      } finally {
        await releaseCycleLock?.();
      }
    },
  };
}
