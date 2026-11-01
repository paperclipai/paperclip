import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { directorySnapshotSha256, withDirectoryMergeLock, type DirectorySnapshot } from "./workspace-restore-merge.js";
import { assertWorkspaceManifestDiskSpace } from "./workspace-manifest.js";
import type { GitWorkspaceSnapshot } from "./git-workspace-sync.js";
import type { WorkspaceDurableSeedPaths } from "./sandbox-managed-runtime.js";
import type { RuntimeSpanRunner } from "./acpx-engine/startup-timing.js";

export function workspaceSeedGeneration(baseline: DirectorySnapshot, git: GitWorkspaceSnapshot | null, repositories: NonNullable<GitWorkspaceSnapshot["repositories"]> = [], scope: "workspace" | "company" = "workspace"): string {
  const identity = (snapshot: GitWorkspaceSnapshot | null): unknown => snapshot && ({
    head: snapshot.headCommit, ...(scope === "workspace" ? { branch: snapshot.branchName } : {}), origin: snapshot.originUrl,
    repositories: snapshot.repositories?.map((repo) => ({ path: repo.path, git: identity(repo.snapshot) })),
  });
  return createHash("sha256").update(scope === "company" ? "verified-company-seed-v1\0" : "verified-seed-v1\0").update(JSON.stringify([directorySnapshotSha256(baseline), identity(git), repositories.map((repo) => ({ path: repo.path, git: identity(repo.snapshot) }))])).digest("hex");
}

export function workspaceSeedCloneSnapshot(snapshot: GitWorkspaceSnapshot): GitWorkspaceSnapshot {
  return { ...snapshot, branchName: null,
    ...(snapshot.repositories ? { repositories: snapshot.repositories.map(repository => ({ ...repository, snapshot: workspaceSeedCloneSnapshot(repository.snapshot) })) } : {}),
  };
}
async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** A privateCopyDirectory must be caller-owned staging; its caller owns cleanup. */
export async function readWorkspaceSeedGeneration(root: string, generation: string,
  options: { companyDirectory?: string; privateCopyDirectory?: string; runtimeSpan?: RuntimeSpanRunner } = {}): Promise<WorkspaceDurableSeedPaths | null> {
  const measure = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    options.runtimeSpan ? options.runtimeSpan(name, work) : work();
  const directory = path.join(root, generation);
  let privateCopy: string | null = null;
  let accepted = false;
  try {
    for (const item of [root, directory]) { const stat = await fs.lstat(item); if (!stat.isDirectory() || stat.isSymbolicLink()) return null; }
    const receipt = path.join(directory, "receipt.json");
    const receiptStat = await fs.lstat(receipt);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 4096) return null;
    const metadata = JSON.parse(await fs.readFile(receipt, "utf8"));
    if (!/^[a-f0-9]{64}$/.test(metadata.workspaceSha256) || (metadata.gitSha256 !== null && !/^[a-f0-9]{64}$/.test(metadata.gitSha256))) return null;
    if (metadata.version !== 1 || metadata.generation !== generation) return null;
    if (options.privateCopyDirectory) {
      const stat = await fs.lstat(options.privateCopyDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      privateCopy = await fs.mkdtemp(path.join(options.privateCopyDirectory, "verified-seed-"));
    }
    const archiveDirectory = privateCopy ?? directory;
    const workspaceArchivePath = path.join(archiveDirectory, "workspace.tar");
    const gitArchivePath = metadata.gitSha256 ? path.join(archiveDirectory, "git.tar") : null;
    for (const [file, expected] of [[workspaceArchivePath, metadata.workspaceSha256], [gitArchivePath, metadata.gitSha256]]) {
      if (!file) continue;
      const source = path.join(directory, path.basename(file));
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      // Hash the exact private bytes staging will consume. This avoids a
      // second source hash and remains valid if the shared cache changes later.
      if (privateCopy) await measure("workspace.seed_read_copy", () => fs.copyFile(source, file, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL));
      if (await measure("workspace.seed_read_hash", () => digest(file)) !== expected) return null;
    }
    const used = await measure("workspace.seed_read_touch", () => withDirectoryMergeLock(path.resolve(options.companyDirectory ?? root), async () => {
      const current = await fs.lstat(receipt).catch(() => null);
      if (!current || current.ino !== receiptStat.ino || current.dev !== receiptStat.dev) return false;
      const usedAt = new Date();
      await fs.utimes(receipt, usedAt, usedAt);
      return true;
    }));
    if (!used) return null;
    accepted = true;
    return { workspaceArchivePath, workspaceArchiveSha256: metadata.workspaceSha256,
      gitArchivePath, gitArchiveSha256: metadata.gitSha256 };
  } catch { return null; }
  finally { if (!accepted && privateCopy) await fs.rm(privateCopy, { recursive: true, force: true }).catch(() => undefined); }
}
export const WORKSPACE_SEED_CACHE_LIMITS = Object.freeze({
  workspaceGenerations: 16,
  workspaceBytes: 1024 ** 3,
  companyGenerations: 256,
  companyWorkspaces: 256,
  companyBytes: 8 * 1024 ** 3,
});
type SeedCacheLimits = { [Key in keyof typeof WORKSPACE_SEED_CACHE_LIMITS]: number };

export const WORKSPACE_SEED_CACHE_EVICTION = Object.freeze({
  idleMs: 7 * 24 * 60 * 60 * 1000,
  minIdleMs: 60 * 60 * 1000,
});
type SeedCacheEviction = { [Key in keyof typeof WORKSPACE_SEED_CACHE_EVICTION]: number };

type CachedGeneration = { directory: string; workspace: string; bytes: number; usedAt: number; evictable: boolean };

async function removeCacheEntry(directory: string) {
  const retired = path.join(path.dirname(directory), `.evicted-${randomUUID()}`);
  await fs.rename(directory, retired);
  await fs.rm(retired, { recursive: true, force: true });
}

async function cachedGenerations(company: string, root: string, cleanup: boolean): Promise<{ workspaces: string[]; generations: CachedGeneration[] }> {
  const workspaces = root === company ? [company]
    : (await fs.readdir(company)).map(name => path.join(company, name));
  const generations: CachedGeneration[] = [];
  for (const workspace of workspaces) {
    const workspaceStat = await fs.lstat(workspace).catch(() => null);
    if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) continue;
    for (const name of await fs.readdir(workspace)) {
      const directory = path.join(workspace, name);
      if (name.startsWith(".evicted-")) { if (cleanup) await fs.rm(directory, { recursive: true, force: true }); continue; }
      const stat = await fs.lstat(directory).catch(() => null);
      if (!stat) continue;
      const evictable = /^[a-f0-9]{64}$/.test(name) && stat.isDirectory() && !stat.isSymbolicLink();
      if (!stat.isDirectory() || stat.isSymbolicLink()) { generations.push({ directory, workspace, bytes: stat.size, usedAt: stat.mtimeMs, evictable }); continue; }
      let bytes = 0, usedAt = stat.mtimeMs;
      for (const child of await fs.readdir(directory)) {
        const file = await fs.lstat(path.join(directory, child)).catch(() => null);
        if (!file?.isFile()) continue;
        bytes += file.size;
        if (child === "receipt.json") usedAt = file.mtimeMs;
      }
      generations.push({ directory, workspace, bytes, usedAt, evictable });
    }
  }
  return { workspaces, generations };
}

async function evictSeedGenerations(company: string, root: string, input: {
  generation: string; incomingBytes: number; limits: SeedCacheLimits; eviction: SeedCacheEviction; now: number; apply: boolean;
}): Promise<boolean> {
  const { workspaces: workspaceDirectories, generations } = await cachedGenerations(company, root, input.apply);
  const remove = async (directory: string) => { if (input.apply) await removeCacheEntry(directory); };
  const target = path.join(root, input.generation);
  const live: CachedGeneration[] = [];
  for (const entry of generations) {
    if (entry.evictable && entry.directory !== target && entry.usedAt < input.now - input.eviction.idleMs) await remove(entry.directory);
    else live.push(entry);
  }
  const over = () => {
    const inWorkspace = live.filter(entry => entry.workspace === root);
    const workspaces = new Set([...live.map(entry => entry.workspace), root]).size;
    return {
      workspace: inWorkspace.length + 1 > input.limits.workspaceGenerations
        || inWorkspace.reduce((sum, entry) => sum + entry.bytes, 0) + input.incomingBytes > input.limits.workspaceBytes,
      company: live.length + 1 > input.limits.companyGenerations
        || live.reduce((sum, entry) => sum + entry.bytes, 0) + input.incomingBytes > input.limits.companyBytes
        || workspaces > input.limits.companyWorkspaces,
    };
  };
  for (let pressure = over(); pressure.workspace || pressure.company; pressure = over()) {
    const victim = live
      .filter(entry => entry.evictable && entry.directory !== target && entry.usedAt < input.now - input.eviction.minIdleMs
        && (pressure.company || entry.workspace === root))
      .sort((a, b) => a.usedAt - b.usedAt)[0];
    if (!victim) return false;
    await remove(victim.directory);
    live.splice(live.indexOf(victim), 1);
  }
  if (input.apply && root !== company) {
    for (const workspace of workspaceDirectories) {
      if (workspace !== root && !live.some(entry => entry.workspace === workspace)) await fs.rmdir(workspace).catch(() => undefined);
    }
  }
  return true;
}

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

export async function publishWorkspaceSeedGeneration(
  root: string, generation: string, seed: WorkspaceDurableSeedPaths,
  options: { companyDirectory?: string; limits?: Partial<SeedCacheLimits>; eviction?: Partial<SeedCacheEviction>;
    scope?: "workspace" | "company"; now?: () => number; verify?: () => Promise<boolean>;
    cacheOnlyGitArchivePath?: string;
    runtimeSpan?: RuntimeSpanRunner } = {},
): Promise<boolean> {
  const measure = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    options.runtimeSpan ? options.runtimeSpan(name, work) : work();
  const configuredLimits = { ...WORKSPACE_SEED_CACHE_LIMITS, ...options.limits };
  const limits = options.scope === "company" ? { ...configuredLimits,
    workspaceGenerations: configuredLimits.companyGenerations, workspaceBytes: configuredLimits.companyBytes,
  } : configuredLimits;
  const eviction = { ...WORKSPACE_SEED_CACHE_EVICTION, ...options.eviction };
  if (!/^[a-f0-9]{64}$/.test(generation)
    || Object.values(configuredLimits).some(value => !Number.isSafeInteger(value) || value < 0)) return false;
  root = path.resolve(root);
  const company = path.resolve(options.companyDirectory ?? root);
  if (root !== company && path.dirname(root) !== company) return false;
  try {
    await fs.mkdir(company, { recursive: true, mode: 0o700 });
    const companyStat = await fs.lstat(company);
    if (!companyStat.isDirectory() || companyStat.isSymbolicLink()) return false;
    const cacheSeed = options.cacheOnlyGitArchivePath
      ? { ...seed, gitArchivePath: options.cacheOnlyGitArchivePath } : seed;
    if (options.cacheOnlyGitArchivePath) {
      if (!seed.gitArchivePath) return false;
      const [cached, recovery] = await Promise.all([
        fs.lstat(options.cacheOnlyGitArchivePath), fs.lstat(seed.gitArchivePath),
      ]);
      // Only a separate, rebuildable archive may omit the existing flush.
      // A pathname alone cannot distinguish it from a recovery hardlink.
      if (!cached.isFile() || cached.isSymbolicLink() || !recovery.isFile() || recovery.isSymbolicLink()
        || (cached.dev === recovery.dev && cached.ino === recovery.ino)) return false;
    }
    const capacity = async (): Promise<"existing" | "available" | false> => {
      const currentCompany = await fs.lstat(company);
      if (!currentCompany.isDirectory() || currentCompany.isSymbolicLink()
        || currentCompany.dev !== companyStat.dev || currentCompany.ino !== companyStat.ino) return false;
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
      if (workspaceExists && await fs.lstat(path.join(root, generation)).then(() => true, () => false)) return "existing";
      let incomingBytes = 4096;
      for (const archive of [cacheSeed.workspaceArchivePath, cacheSeed.gitArchivePath]) {
        if (!archive) continue;
        const stat = await fs.lstat(archive);
        if (!stat.isFile() || stat.isSymbolicLink()) return false;
        incomingBytes += stat.size;
      }
      if (incomingBytes > configuredLimits.workspaceBytes) return false;
      if (workspace.generations + 1 > limits.workspaceGenerations || workspace.bytes + incomingBytes > limits.workspaceBytes
        || totalGenerations + 1 > limits.companyGenerations || totalBytes + incomingBytes > limits.companyBytes
        || workspaces + (workspaceExists ? 0 : 1) > limits.companyWorkspaces) return false;
      assertWorkspaceManifestDiskSpace(company, incomingBytes);
      return "available";
    };
    const initialCapacity = await measure("workspace.seed_cache_capacity", capacity);
    if (initialCapacity === "existing") return true;
    let incomingBytes = 4096;
    for (const archive of [cacheSeed.workspaceArchivePath, cacheSeed.gitArchivePath]) if (archive) incomingBytes += (await fs.lstat(archive)).size;
    if (incomingBytes > configuredLimits.workspaceBytes) return false;
    const plan = { generation, incomingBytes, limits, eviction, now: options.now?.() ?? Date.now() };
    if (initialCapacity === false && !await measure("workspace.seed_cache_evict", () => evictSeedGenerations(company, root, { ...plan, apply: false }))) return false;
    if (options.verify && !await options.verify()) return false;
    return await withDirectoryMergeLock(company, () => measure("workspace.seed_cache_locked_publish", async () => {
      const lockedCompany = await fs.lstat(company);
      if (!lockedCompany.isDirectory() || lockedCompany.isSymbolicLink()
        || lockedCompany.dev !== companyStat.dev || lockedCompany.ino !== companyStat.ino) return false;
      await measure("workspace.seed_cache_evict", () => evictSeedGenerations(company, root, { ...plan, apply: true }));
      const currentCapacity = await measure("workspace.seed_cache_capacity", capacity);
      if (currentCapacity !== "available") return currentCapacity === "existing";
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = path.join(root, `.pending-${randomUUID()}`);
      await fs.mkdir(temporary, { mode: 0o700 });
      try {
        const copy = async (source: string, name: string, flush = true) => {
          const target = path.join(temporary, name);
          await measure("workspace.seed_cache_copy", () => fs.link(source, target).catch(() => fs.copyFile(source, target)));
          if (!flush && seed.gitArchivePath) {
            const [cached, recovery] = await Promise.all([fs.lstat(target), fs.lstat(seed.gitArchivePath)]);
            if (cached.dev === recovery.dev && cached.ino === recovery.ino) throw new Error("workspace_seed_cache_recovery_alias");
          }
          if (flush) await measure("workspace.seed_cache_sync", async () => {
            const file = await fs.open(target, "r");
            try { await file.sync(); } finally { await file.close(); }
          });
          return measure("workspace.seed_cache_hash", () => digest(target));
        };
        const workspaceSha256 = await copy(seed.workspaceArchivePath, "workspace.tar");
        // Shared Git seeds have no task branch and are not recovery archives.
        // Missing or corrupt cache-only bytes are rejected by the reader.
        const gitSha256 = cacheSeed.gitArchivePath
          ? await copy(cacheSeed.gitArchivePath, "git.tar", !options.cacheOnlyGitArchivePath) : null;
        await fs.writeFile(path.join(temporary, "receipt.json"), JSON.stringify({ version: 1, generation, workspaceSha256, gitSha256 }));
        await fs.rename(temporary, path.join(root, generation));
        return true;
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    }));
  } catch { return false; }
}
