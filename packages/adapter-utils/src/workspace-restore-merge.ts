import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { shouldExcludePath } from "./exclude-patterns.js";

type SnapshotEntry =
  | { kind: "dir" }
  | { kind: "file"; mode: number; hash: string }
  | { kind: "symlink"; target: string };

export interface DirectorySnapshot {
  exclude: string[];
  entries: Map<string, SnapshotEntry>;
}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkDirectory(
  root: string,
  exclude: readonly string[],
  relative = "",
  out: Map<string, SnapshotEntry> = new Map(),
): Promise<Map<string, SnapshotEntry>> {
  const current = relative ? path.join(root, relative) : root;
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const nextRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldExcludePath(nextRelative, exclude)) continue;

    const fullPath = path.join(root, nextRelative);
    const stats = await fs.lstat(fullPath);
    if (!stats.isDirectory() && !stats.isSymbolicLink() && !stats.isFile()) {
      continue;
    }

    if (stats.isDirectory()) {
      out.set(nextRelative, { kind: "dir" });
      await walkDirectory(root, exclude, nextRelative, out);
      continue;
    }

    if (stats.isSymbolicLink()) {
      out.set(nextRelative, {
        kind: "symlink",
        target: await fs.readlink(fullPath),
      });
      continue;
    }

    out.set(nextRelative, {
      kind: "file",
      mode: stats.mode,
      hash: await hashFile(fullPath),
    });
  }

  return out;
}

async function readSnapshotEntry(root: string, relative: string): Promise<SnapshotEntry | null> {
  const fullPath = path.join(root, relative);
  let stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) return { kind: "dir" };
  if (stats.isSymbolicLink()) {
    return {
      kind: "symlink",
      target: await fs.readlink(fullPath),
    };
  }
  if (!stats.isFile()) return null;

  return {
    kind: "file",
    mode: stats.mode,
    hash: await hashFile(fullPath),
  };
}

function entriesMatch(left: SnapshotEntry | null | undefined, right: SnapshotEntry | null | undefined): boolean {
  if (!left || !right) return false;
  if (left.kind !== right.kind) return false;
  if (left.kind === "dir") return true;
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return left.mode === right.mode && left.hash === right.hash;
  }
  return false;
}

// The restore lock is only ever legitimately held by the *current* server process.
// That process runs as the same low in-container PID (e.g. 7) across restarts, so a
// bare process.kill(pid, 0) liveness check can never reclaim a lock left by a crashed
// prior incarnation whose PID the new process reuses — restores then deadlock forever.
// We disambiguate incarnations with a per-process token and keep an age backstop for
// legacy locks written before the token existed.
//
// INVARIANT: exactly one live server process holds this lock at a time, so a foreign
// token is always a dead prior incarnation and is reclaimed immediately. The token
// MUST rotate per process start and must NOT be derived from pid/hostname, or the
// collision returns. If the deployment ever runs two live servers against the same
// lock directory (blue/green overlap), a genuinely-held lock would be reclaimed
// without grace — switch to an OS-attested advisory lock (flock/OFD) before then.
const RESTORE_LOCK_INSTANCE_ID = `${process.pid}:${randomUUID()}`;
const RESTORE_LOCK_STALE_TTL_MS = 15 * 60_000;

function parseCreatedAtMs(createdAt: unknown): number | null {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt === "string") {
    const ms = Date.parse(createdAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

async function readLockOwner(
  lockDir: string,
): Promise<{ pid?: unknown; createdAt?: unknown; instanceId?: unknown } | null> {
  // Retry briefly on a missing owner.json: the lock dir may have just been created by
  // another acquirer that has not yet written owner.json. This avoids stealing a lock
  // mid-claim, while still returning null (=> treat as stale) if the creator crashed
  // between the mkdir and the owner.json write.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
      return JSON.parse(raw) as { pid?: unknown; createdAt?: unknown; instanceId?: unknown };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "ENOENT" || attempt >= 4) return null; // absent-after-grace / corrupt => stale
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function isHolderAlive(lockDir: string): Promise<boolean> {
  const owner = await readLockOwner(lockDir);
  if (owner === null) return false;

  const instanceId = typeof owner.instanceId === "string" ? owner.instanceId : null;
  if (instanceId !== null) {
    // Written by the current lock protocol. A token from another incarnation is a
    // crashed prior process (whose PID the current server may have reused), so the
    // lock is stale; a matching token is our own live restore, which we respect.
    return instanceId === RESTORE_LOCK_INSTANCE_ID;
  }

  // Legacy lock (no instanceId): reclaim once it ages past the TTL. A present-but-
  // unparseable createdAt cannot vouch for the holder, so treat it as stale rather
  // than trusting the PID (which collides across restarts) and deadlocking forever.
  if (owner.createdAt !== undefined) {
    const createdMs = parseCreatedAtMs(owner.createdAt);
    if (createdMs === null || Date.now() - createdMs > RESTORE_LOCK_STALE_TTL_MS) {
      return false;
    }
  }
  const pid = typeof owner.pid === "number" && Number.isFinite(owner.pid) && owner.pid > 0 ? owner.pid : null;
  if (pid === null) {
    // Owner record is missing a usable pid — treat as stale.
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireDirectoryMergeLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 30_000;
  const nonce = randomUUID();
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, instanceId: RESTORE_LOCK_INSTANCE_ID, nonce, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        // Ownership-checked release: only remove the lock if this exact acquisition
        // still owns it (same incarnation AND same nonce), so a slow release can't
        // delete a lock a later restore has since acquired.
        try {
          const raw = await fs.readFile(path.join(lockDir, "owner.json"), "utf8");
          const owner = JSON.parse(raw) as { instanceId?: unknown; nonce?: unknown };
          if (owner.instanceId !== RESTORE_LOCK_INSTANCE_ID || owner.nonce !== nonce) return;
        } catch {
          return; // owner.json gone/unreadable — nothing of ours to remove
        }
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw error;
      // Stale-lock detection: a lock left by a crashed prior incarnation (SIGKILL /
      // OOM / restart) must be reclaimed or it stalls restores forever.
      if (!(await isHolderAlive(lockDir))) {
        // Reclaim atomically: whoever wins the rename owns the removal, so two racing
        // acquirers can never both delete-and-recreate the same lockDir. The loser
        // gets ENOENT here and simply retries the atomic mkdir on the next iteration.
        const reclaimPath = `${lockDir}.reclaiming-${RESTORE_LOCK_INSTANCE_ID}-${randomUUID()}`;
        try {
          await fs.rename(lockDir, reclaimPath);
        } catch {
          continue; // another acquirer already reclaimed/replaced it — retry
        }
        await fs.rm(reclaimPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace restore lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function withDirectoryMergeLock<T>(
  targetDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const releaseLock = await acquireDirectoryMergeLock(`${targetDir}.paperclip-restore.lock`);
  try {
    return await fn();
  } finally {
    await releaseLock();
  }
}

async function copySnapshotEntry(sourceDir: string, targetDir: string, relative: string, entry: SnapshotEntry): Promise<void> {
  const sourcePath = path.join(sourceDir, relative);
  const targetPath = path.join(targetDir, relative);

  if (entry.kind === "dir") {
    const existing = await fs.lstat(targetPath).catch(() => null);
    if (existing?.isDirectory()) {
      return;
    }
    if (existing) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.mkdir(targetPath, { recursive: true });
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  if (entry.kind === "symlink") {
    await fs.symlink(entry.target, targetPath);
    return;
  }

  await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
    await fs.copyFile(sourcePath, targetPath);
  });
  await fs.chmod(targetPath, entry.mode);
}

export async function captureDirectorySnapshot(
  rootDir: string,
  options: { exclude?: string[] } = {},
): Promise<DirectorySnapshot> {
  const exclude = [...new Set(options.exclude ?? [])];
  return {
    exclude,
    entries: await walkDirectory(rootDir, exclude),
  };
}

export async function mergeDirectoryWithBaseline(input: {
  baseline: DirectorySnapshot;
  sourceDir: string;
  targetDir: string;
  beforeApply?: () => Promise<void>;
  afterApply?: () => Promise<void>;
}): Promise<void> {
  const source = await captureDirectorySnapshot(input.sourceDir, { exclude: input.baseline.exclude });
  await withDirectoryMergeLock(input.targetDir, async () => {
    await input.beforeApply?.();
    const current = await captureDirectorySnapshot(input.targetDir, { exclude: input.baseline.exclude });
    const deletedLeafEntries = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind !== "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative, baselineEntry] of deletedLeafEntries) {
      if (!entriesMatch(current.entries.get(relative), baselineEntry)) continue;
      await fs.rm(path.join(input.targetDir, relative), { recursive: true, force: true }).catch(() => undefined);
    }

    const deletedDirs = [...input.baseline.entries.entries()]
      .filter(([relative, entry]) => entry.kind === "dir" && !source.entries.has(relative))
      .sort(([left], [right]) => right.length - left.length);

    for (const [relative] of deletedDirs) {
      await fs.rmdir(path.join(input.targetDir, relative)).catch(() => undefined);
    }

    const changedSourceEntries = [...source.entries.entries()]
      .filter(([relative, entry]) => !entriesMatch(input.baseline.entries.get(relative), entry))
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [relative, entry] of changedSourceEntries) {
      await copySnapshotEntry(input.sourceDir, input.targetDir, relative, entry);
    }

    await input.afterApply?.();
  });
}

export async function directoryEntryMatchesBaseline(
  rootDir: string,
  relative: string,
  baselineEntry: SnapshotEntry,
): Promise<boolean> {
  return entriesMatch(await readSnapshotEntry(rootDir, relative), baselineEntry);
}
