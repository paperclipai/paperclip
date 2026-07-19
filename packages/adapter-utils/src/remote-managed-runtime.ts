import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
} from "./ssh.js";
import { captureDirectorySnapshot } from "./workspace-restore-merge.js";
import {
  readRunWorkspaceGcConfig,
  removeRemoteRunWorkspaces,
  runsRootRemoteDir,
  sweepRemoteRunWorkspaces,
} from "./runtime-workspace-gc.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
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

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  assets?: RemoteManagedRuntimeAsset[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
}): Promise<PreparedRemoteManagedRuntime> {
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  const runsRoot = runsRootRemoteDir(baseWorkspaceRemoteDir);
  const workspaceRemoteDir = path.posix.join(runsRoot, input.runId, "workspace");
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const gcConfig = readRunWorkspaceGcConfig();

  // Opportunistic GC: reclaim stale sibling run dirs before staging a new one. This is the
  // backstop for crashed / timed-out runs whose `restoreWorkspace()` (and its delete-on-completion)
  // never ran — the exact leak that filled the disk. Spare the current run and never let a sweep
  // failure abort the run it guards.
  try {
    const { deletedRunIds } = await sweepRemoteRunWorkspaces({
      spec: input.spec,
      runsRootRemoteDir: runsRoot,
      config: gcConfig,
      now: Date.now(),
      activeRunIds: [input.runId],
    });
    if (deletedRunIds.length > 0) {
      input.onProgress?.(`Reclaimed ${deletedRunIds.length} stale run workspace(s).`);
    }
  } catch (error) {
    input.onProgress?.(
      `Run workspace GC sweep skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const preparedWorkspace = await prepareWorkspaceForSshExecution({
    spec: input.spec,
    localDir: input.workspaceLocalDir,
    remoteDir: workspaceRemoteDir,
    onProgress: input.onProgress,
  });
  const restoreExclude = preparedWorkspace.gitBacked ? [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"] : [".paperclip-runtime"];
  const baselineSnapshot = await captureDirectorySnapshot(input.workspaceLocalDir, {
    exclude: restoreExclude,
  });

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
    await restoreWorkspaceFromSshExecution({
      spec: input.spec,
      localDir: input.workspaceLocalDir,
      remoteDir: workspaceRemoteDir,
      baselineSnapshot,
      restoreGitHistory: preparedWorkspace.gitBacked,
      onProgress: input.onProgress,
    });
    throw error;
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress,
      });
      // Delete-on-completion: the per-run copy is throwaway once changes are merged back. Remove
      // the whole `runs/<runId>` dir (workspace + adapter assets) unless kept for debugging. Best
      // effort — a cleanup failure must not fail an otherwise-successful run; the sweep on the next
      // run is the backstop.
      if (!gcConfig.keepOnCompletion) {
        try {
          await removeRemoteRunWorkspaces({
            spec: input.spec,
            runsRootRemoteDir: runsRoot,
            runIds: [input.runId],
          });
        } catch (error) {
          onProgress?.(
            `Run workspace cleanup skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  };
}
