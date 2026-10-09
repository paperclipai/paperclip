import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { type DirectorySnapshot, type SnapshotEntry } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { captureAgentFiles, checkpointPath, type AgentFileManifest, type AgentFileCheckpointStats } from "./scripts/agent-file-checkpoint.mjs";
import { inspectAgentFile, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_FILE_BYTES } from "./agent-file-store.js";

export type { AgentFileManifest, AgentFileCheckpointStats };
const quote = (text: string) => `'${text.replaceAll("'", `'"'"'`)}'`;
export function checkpointSnapshot(manifest: AgentFileManifest): DirectorySnapshot {
  return { exclude: [], entries: new Map(manifest.entries.map(([name, entry]) => [name,
    entry.kind === "dir" ? { kind: "dir" } : { kind: "file", mode: entry.mode!, hash: entry.hash! }] as [string, SnapshotEntry])) };
}
export function checkpointBaseline(snapshot: DirectorySnapshot): AgentFileManifest {
  return { version: 1, entries: [...snapshot.entries].map(([name, entry]) => {
    if (entry.kind === "symlink") throw new Error("Agent file baseline contains a link");
    return [name, entry];
  }) };
}
export async function cachedAgentFileManifest(root: string): Promise<AgentFileManifest> {
  const filename = path.join(path.dirname(root), "file-sync", "canonical-manifest.json");
  const previous = await fs.readFile(filename, "utf8").then(s => JSON.parse(s) as AgentFileManifest).catch(() => undefined);
  const { manifest } = await captureAgentFiles(root, previous, undefined, false);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}`;
  try { await fs.writeFile(temporary, JSON.stringify(manifest)); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
  return manifest;
}

/** Host validation does not trust remote hashes, paths, claimed sizes or quotas.
 * A missing payload must match the last committed manifest exactly. */
export async function validateAgentFileCheckpoint(directory: string, previous: AgentFileManifest): Promise<AgentFileManifest> {
  const filename = path.join(directory, "checkpoint.json");
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("Invalid agent file checkpoint manifest");
  const bytes = await fs.readFile(filename);
  if (bytes.length > 64 * 1024 * 1024) throw new Error("Agent file checkpoint manifest is too large");
  const manifest = JSON.parse(bytes.toString("utf8")) as AgentFileManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_AGENT_DIRECTORY_ENTRIES) throw new Error("Invalid agent file checkpoint");
  const old = new Map(previous.entries), names = new Set<string>();
  let total = 0;
  for (const item of manifest.entries) {
    if (!Array.isArray(item) || item.length !== 2) throw new Error("Invalid agent file checkpoint entry");
    const [name, entry] = item;
    checkpointPath(name);
    if (names.has(name) || !entry || !["dir", "file"].includes(entry.kind)) throw new Error("Invalid agent file checkpoint entry");
    names.add(name);
    if (entry.kind === "dir") continue;
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || entry.size! > MAX_AGENT_FILE_BYTES ||
        !Number.isSafeInteger(entry.mode) || !/^[a-f0-9]{64}$/.test(entry.hash ?? "") || typeof entry.stamp !== "string") throw new Error("Invalid agent file checkpoint metadata");
    total += entry.size!;
    if (total > MAX_AGENT_DIRECTORY_BYTES) throw new Error("Agent file checkpoint exceeds quota");
    const before = old.get(name);
    if (before?.kind === "file" && before.hash === entry.hash && before.mode === entry.mode) {
      if (before.size !== undefined && before.size !== entry.size) throw new Error("Agent file checkpoint size changed without content");
    } else {
      const file = await inspectAgentFile(path.join(directory, "files"), name, 0);
      if (!file || file.hash !== entry.hash || file.size !== entry.size) throw new Error("Agent file checkpoint payload mismatch");
    }
  }
  const entries = new Map(manifest.entries);
  for (const name of names) for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
    if (entries.get(parent)?.kind !== "dir") throw new Error("Agent file checkpoint parent is missing");
  }
  return { ...manifest, totalBytes: total };
}

export async function captureAgentFileCheckpoint(input: {
  runId: string; localRoot: string; executionRoot: string; previous: AgentFileManifest; target?: AdapterExecutionTarget | null;
}): Promise<{ directory: string; manifest: AgentFileManifest; stats: AgentFileCheckpointStats; cleanup: () => Promise<void> }> {
  const directory = path.join(path.dirname(input.localRoot), `checkpoint-${randomUUID()}`);
  const target = input.target?.kind === "remote" ? input.target : null;
  // Scratch lives inside this session's reserved runtime area, so retirement
  // reclaims it even if a transient transport failure interrupted cleanup.
  const remoteDirectory = target ? path.posix.join(input.executionRoot, ".paperclip-runtime", path.basename(directory)) : null;
  let restore: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | undefined;
  let cacheRuntime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | undefined;
  const cleanup = async () => {
    try {
      await restore?.cleanupWorkspaceSnapshot?.();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      if (target && remoteDirectory) {
        const paths = [...new Set([remoteDirectory, cacheRuntime?.runtimeRootDir, restore?.runtimeRootDir].filter((p): p is string => Boolean(p)))];
        const result = await runAdapterExecutionTargetShellCommand(input.runId, target, `rm -rf -- ${paths.map(quote).join(" ")}`, { cwd: target.remoteCwd, env: {}, timeoutSec: 15 });
        if (result.exitCode !== 0 || result.timedOut) throw new Error("Agent checkpoint cleanup failed");
      }
    }
  };
  try {
    let stats: AgentFileCheckpointStats;
    if (!target) ({ stats } = await captureAgentFiles(input.localRoot, input.previous, directory));
    else {
      const cacheDir = path.join(directory, "cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const cache = JSON.stringify(input.previous);
      await fs.writeFile(path.join(cacheDir, "manifest.json"), cache);
      const prepared = cacheRuntime = await prepareAdapterExecutionTargetRuntime({ target, runId: input.runId, adapterKey: `agent-checkpoint-${path.basename(directory)}`,
        workspaceLocalDir: directory, workspaceRemoteDir: remoteDirectory!, syncWorkspace: false, assets: [{ key: "cache", localDir: cacheDir, followSymlinks: false }] });
      const script = await fs.readFile(new URL("./scripts/agent-file-checkpoint.mjs", import.meta.url), "utf8");
      const options = { root: input.executionRoot, output: remoteDirectory, cacheFile: path.posix.join(prepared.assetDirs.cache!, "manifest.json"), cacheHash: createHash("sha256").update(cache).digest("hex") };
      const result = await runAdapterExecutionTargetShellCommand(input.runId, target, `node --input-type=module -e ${quote(script)} -- --checkpoint ${quote(JSON.stringify(options))}`,
        { cwd: target.remoteCwd, env: {}, timeoutSec: 120 });
      if (result.exitCode !== 0 || result.timedOut) throw new Error(`Agent file checkpoint failed: ${result.stderr.trim()}`);
      stats = JSON.parse(result.stdout.trim()) as AgentFileCheckpointStats;
      await fs.rm(cacheDir, { recursive: true, force: true });
      restore = await prepareAdapterExecutionTargetRuntime({ target, runId: input.runId, adapterKey: `agent-checkpoint-download-${path.basename(directory)}`, workspaceLocalDir: directory,
        workspaceRemoteDir: remoteDirectory!, syncWorkspace: true, workspaceInboundMode: "adopt_remote", workspaceBaseline: { exclude: [], entries: new Map() }, workspaceGitSnapshot: null, workspaceFileMode: "all" });
      await restore.restoreWorkspace();
    }
    return { directory, manifest: await validateAgentFileCheckpoint(directory, input.previous), stats, cleanup };
  } catch (error) { await cleanup().catch(() => undefined); throw error; }
}
