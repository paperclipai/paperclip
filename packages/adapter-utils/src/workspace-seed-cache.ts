import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { directorySnapshotSha256, type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { GitWorkspaceSnapshot } from "./git-workspace-sync.js";
import type { WorkspaceDurableSeedPaths } from "./sandbox-managed-runtime.js";

export function workspaceSeedGeneration(baseline: DirectorySnapshot, git: GitWorkspaceSnapshot | null, repositories: NonNullable<GitWorkspaceSnapshot["repositories"]> = []): string {
  const identity = (snapshot: GitWorkspaceSnapshot | null): unknown => snapshot && ({
    head: snapshot.headCommit, branch: snapshot.branchName, origin: snapshot.originUrl,
    repositories: snapshot.repositories?.map((repo) => ({ path: repo.path, git: identity(repo.snapshot) })),
  });
  return createHash("sha256").update("verified-seed-v1\0").update(JSON.stringify([directorySnapshotSha256(baseline), identity(git), repositories.map((repo) => ({ path: repo.path, git: identity(repo.snapshot) }))])).digest("hex");
}
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Cache is durable but never authority: every archive is checked before reuse.
 * Admitted runs retain their own hard link, independent of cache cleanup. */
export async function readWorkspaceSeedGeneration(root: string, generation: string): Promise<WorkspaceDurableSeedPaths | null> {
  const directory = path.join(root, generation);
  try {
    for (const item of [root, directory]) { const stat = await fs.lstat(item); if (!stat.isDirectory() || stat.isSymbolicLink()) return null; }
    const receipt = path.join(directory, "receipt.json");
    const receiptStat = await fs.lstat(receipt);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096) return null;
    const metadata = JSON.parse(await fs.readFile(receipt, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(metadata.workspaceSha256) || (metadata.gitSha256 !== null && !/^[a-f0-9]{64}$/.test(metadata.gitSha256))) return null;
    if (metadata.version !== 1 || metadata.generation !== generation) return null;
    const workspaceArchivePath = path.join(directory, "workspace.tar");
    const gitArchivePath = metadata.gitSha256 ? path.join(directory, "git.tar") : null;
    for (const [file, expected] of [[workspaceArchivePath, metadata.workspaceSha256], [gitArchivePath, metadata.gitSha256]]) {
      if (!file) continue;
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await digest(file) !== expected) return null;
    }
    return { workspaceArchivePath, workspaceArchiveSha256: metadata.workspaceSha256,
      gitArchivePath, gitArchiveSha256: metadata.gitSha256 };
  } catch { return null; }
}
export async function publishWorkspaceSeedGeneration(root: string, generation: string, seed: WorkspaceDurableSeedPaths): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("workspace_seed_cache_root_invalid");
  const temporary = path.join(root, `.pending-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    const copy = async (source: string, name: string) => {
      const target = path.join(temporary, name);
      await fs.link(source, target).catch(() => fs.copyFile(source, target));
      const file = await fs.open(target, "r");
      try { await file.sync(); } finally { await file.close(); }
      return digest(target);
    };
    const workspaceSha256 = await copy(seed.workspaceArchivePath, "workspace.tar");
    const gitSha256 = seed.gitArchivePath ? await copy(seed.gitArchivePath, "git.tar") : null;
    await fs.writeFile(path.join(temporary, "receipt.json"), JSON.stringify({ version: 1, generation, workspaceSha256, gitSha256 }));
    await fs.rename(temporary, path.join(root, generation)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
