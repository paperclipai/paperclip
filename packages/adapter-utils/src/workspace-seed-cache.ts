import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { directorySnapshotSha256, withDirectoryMergeLock, type DirectorySnapshot } from "./workspace-restore-merge.js";
import { assertWorkspaceManifestDiskSpace } from "./workspace-manifest.js";
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
 * Admitted runs retain independent per-run archives; cache entries are never evicted. */
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
export const WORKSPACE_SEED_CACHE_LIMITS = Object.freeze({
  workspaceGenerations: 16,
  workspaceBytes: 1024 ** 3,
  companyGenerations: 256,
  companyWorkspaces: 256,
  companyBytes: 8 * 1024 ** 3,
});
type SeedCacheLimits = { [Key in keyof typeof WORKSPACE_SEED_CACHE_LIMITS]: number };

/** Count even abandoned pending entries and corrupt archives against capacity.
 * Never follow links or recurse into an unexpected cache layout. */
async function cacheUsage(root: string, limits: SeedCacheLimits): Promise<{ generations: number; bytes: number } | null> {
  let generations = 0, bytes = 0;
  for await (const entry of await fs.opendir(root)) {
    if (++generations > limits.companyGenerations) return null;
    const directory = path.join(root, entry.name);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    let files = 0;
    for await (const child of await fs.opendir(directory)) {
      if (++files > 3) return null;
      const file = await fs.lstat(path.join(directory, child.name));
      if (!file.isFile() || file.isSymbolicLink()) return null;
      bytes += file.size;
      if (bytes > limits.companyBytes) return null;
    }
  }
  return { generations, bytes };
}

/** Optional optimization: saturation or cache failure leaves per-run recovery
 * untouched. No eviction: readers may still be using a returned cache path. */
export async function publishWorkspaceSeedGeneration(
  root: string, generation: string, seed: WorkspaceDurableSeedPaths,
  options: { companyDirectory?: string; limits?: Partial<SeedCacheLimits>; verify?: () => Promise<boolean> } = {},
): Promise<boolean> {
  const limits = { ...WORKSPACE_SEED_CACHE_LIMITS, ...options.limits };
  if (!/^[a-f0-9]{64}$/.test(generation)
    || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  root = path.resolve(root);
  const company = path.resolve(options.companyDirectory ?? root);
  if (root !== company && path.dirname(root) !== company) return false;
  try {
    await fs.mkdir(company, { recursive: true, mode: 0o700 });
    const companyStat = await fs.lstat(company);
    if (!companyStat.isDirectory() || companyStat.isSymbolicLink()) return false;
    return await withDirectoryMergeLock(company, async () => {
      let totalGenerations = 0, totalBytes = 0, workspaces = 0;
      let workspace = { generations: 0, bytes: 0 };
      let workspaceExists = false;
      const directories = root === company ? [{ name: "" }] : await fs.opendir(company);
      for await (const { name } of directories) {
        if (++workspaces > limits.companyWorkspaces) return false;
        const directory = root === company ? company : path.join(company, name);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        const usage = await cacheUsage(directory, limits);
        if (!usage) return false;
        totalGenerations += usage.generations; totalBytes += usage.bytes;
        if (totalGenerations > limits.companyGenerations || totalBytes > limits.companyBytes) return false;
        if (directory === root) { workspace = usage; workspaceExists = true; }
      }
      // An existing immutable entry adds no storage, including when saturated.
      if (workspaceExists && await fs.lstat(path.join(root, generation)).then(() => true, () => false)) return true;
      let incomingBytes = 4096; // conservative receipt allowance
      for (const archive of [seed.workspaceArchivePath, seed.gitArchivePath]) {
        if (!archive) continue;
        const stat = await fs.lstat(archive);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        incomingBytes += stat.size;
      }
      if (workspace.generations + 1 > limits.workspaceGenerations || workspace.bytes + incomingBytes > limits.workspaceBytes
        || totalGenerations + 1 > limits.companyGenerations || totalBytes + incomingBytes > limits.companyBytes
        || workspaces + (workspaceExists ? 0 : 1) > limits.companyWorkspaces) return false;
      // Reserve enough for a full copy even when hard links are unavailable.
      assertWorkspaceManifestDiskSpace(company, incomingBytes);
      if (options.verify && !await options.verify()) return false;
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
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
        await fs.rename(temporary, path.join(root, generation));
        return true;
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    });
  } catch { return false; }
}
