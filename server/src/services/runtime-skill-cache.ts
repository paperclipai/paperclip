import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompanySkill } from "@paperclipai/shared";
import { currentControllerProcessStamp, readControllerProcess } from "./controller-process-identity.js";
import { proveOwnerGone, type LocalOwnerStamp, type OwnerProof } from "./owner-proof.js";

/** Bounds one lock-holder proof, which can read the database across process spaces. */
const LOCK_PROOF_TIMEOUT_MS = 5_000;

const FORMAT = 1;
const inFlight = new Map<string, Promise<string>>();
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

type FileRecord = { path: string; size: number; digest: string };
type CacheSpec = { root: string; entry: string; fingerprint: string; paths: string[] };

function filePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
    || normalized.includes("\0")) throw new Error("Invalid runtime skill file path");
  return normalized;
}

export function runtimeSkillCacheRoot(managedRoot: string, skillId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(skillId)) throw new Error("Invalid runtime skill ID");
  // A sibling of __runtime__: old runtime cleanup cannot remove published revisions.
  return path.resolve(managedRoot, `__runtime_cache_v${FORMAT}__`, skillId);
}

export function runtimeSkillCacheSpec(managedRoot: string, skill: CompanySkill): CacheSpec | null {
  if ((skill.sourceType === "github" || skill.sourceType === "skills_sh")
    && !/^[a-f0-9]{40}$/i.test(skill.sourceRef ?? "")) return null;
  const metadata = skill.metadata ?? {};
  const inventory = skill.fileInventory.map((entry) => ({ path: filePath(entry.path), kind: entry.kind }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const paths = inventory.map((entry) => entry.path);
  if (!paths.includes("SKILL.md")) throw new Error("Company skill could not be materialized because its stored SKILL.md copy is missing.");
  if (new Set(paths).size !== paths.length) throw new Error("Invalid runtime skill file inventory");
  // Local supporting files are mutable outside the DB as well as through the
  // editor. Existing directories are used directly; missing-source fallback
  // must reread its files rather than reuse an immutable revision fingerprint.
  if (skill.sourceType === "local_path") return null;
  const fingerprint = digest(JSON.stringify({
    format: FORMAT, companyId: skill.companyId, skillId: skill.id,
    sourceType: skill.sourceType, sourceLocator: skill.sourceLocator, sourceRef: skill.sourceRef,
    // These are the only metadata fields used by the source reader. slug is its fallback directory.
    source: { owner: metadata.owner, repo: metadata.repo, hostname: metadata.hostname,
      ref: skill.sourceRef ? undefined : metadata.ref, repoSkillDir: metadata.repoSkillDir,
      fallbackDirectory: typeof metadata.repoSkillDir === "string" ? undefined : skill.slug },
    markdown: digest(skill.markdown), inventory,
  }));
  const root = runtimeSkillCacheRoot(managedRoot, skill.id);
  return { root, entry: path.join(root, fingerprint), fingerprint, paths };
}

// Check every ancestor before traversing it, including the configured cache root.
async function assertDirectories(directory: string, trustedRoot: string, create = false): Promise<void> {
  const absolute = path.resolve(directory);
  let cursor = path.resolve(trustedRoot);
  if (!absolute.startsWith(`${cursor}${path.sep}`)) throw new Error("Runtime cache escaped its root");
  // Ancestors of the configured storage root may be system aliases (e.g. macOS /var).
  if (create) await fs.mkdir(cursor, { recursive: true });
  const rootStat = await fs.lstat(cursor);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Unsafe runtime skill storage root");
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (create) await fs.mkdir(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe runtime skill cache directory");
  }
}

async function readRegularFile(filename: string): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Unsafe runtime skill cache file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function inventory(directory: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  if ((await fs.lstat(directory)).mode & 0o222) throw new Error("Writable runtime skill cache directory");
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await inventory(path.join(directory, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
    else throw new Error("Symlink or special file in runtime skill cache");
  }
  return out.sort();
}

async function matches(spec: CacheSpec, entry = spec.entry): Promise<boolean> {
  try {
    await assertDirectories(path.join(entry, "files"), path.dirname(path.dirname(spec.root)));
    const manifest = JSON.parse((await readRegularFile(path.join(entry, "manifest.json"))).toString("utf8"));
    if (manifest.format !== FORMAT || manifest.fingerprint !== spec.fingerprint || !Array.isArray(manifest.files)
      || manifest.files.length !== spec.paths.length) return false;
    const actual = await inventory(path.join(entry, "files"));
    if (JSON.stringify(actual) !== JSON.stringify([...spec.paths].sort())) return false;
    const seen = new Set<string>();
    for (const record of manifest.files as FileRecord[]) {
      if (!record || typeof record.path !== "string" || filePath(record.path) !== record.path
        || !spec.paths.includes(record.path) || seen.has(record.path)
        || !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.digest)) return false;
      seen.add(record.path);
      const content = await readRegularFile(path.join(entry, "files", record.path));
      if ((await fs.lstat(path.join(entry, "files", record.path))).mode & 0o222) return false;
      if (content.length !== record.size || digest(content) !== record.digest) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * True only when the shared owner prover shows that a lock holder's recorded
 * server process is gone. Lock age is never proof. In this PID space the PID
 * decides. A holder in another process space (for example before a redeploy)
 * is gone only when the platform replaced its deployment on the same exclusive
 * volume, or when its server boot stopped or was fenced. A lock written before
 * holders recorded their process identity stays held.
 */
export async function runtimeSkillCacheLockHolderExited(lockContent: Buffer, options: {
  /** This wait gives up (the lock stays held) after this long. A stalled read keeps running; later waits on the same holder join it. */
  timeoutMs?: number;
  prove?: (stamp: LocalOwnerStamp) => Promise<OwnerProof>;
} = {}): Promise<boolean> {
  let holder: unknown;
  try { holder = JSON.parse(lockContent.toString("utf8")); } catch { return false; }
  const controller = readControllerProcess((holder as { controller?: unknown } | null)?.controller);
  if (!controller) return false;
  const stamp: LocalOwnerStamp = {
    kind: "local", scope: "runtime_skill_cache_lock", generation: null, host: null, processSpace: controller.hostHash,
    bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt, processGroupId: null,
    ...(controller.deployment ? { worker: controller.deployment.worker, exclusiveVolume: controller.deployment.exclusiveVolume,
      volumeId: controller.deployment.volumeId } : {}),
  };
  // A proof that outlives its timeout keeps running (its database read cannot
  // be cancelled), so later waits on the same holder join it instead of adding
  // another read to the shared pool.
  const key = JSON.stringify(stamp);
  let proved = pendingLockProofs.get(key);
  if (!proved) {
    proved = (options.prove ?? (value => proveOwnerGone(value)))(stamp)
      .then(proof => proof.verdict === "gone", () => false)
      .finally(() => { if (pendingLockProofs.get(key) === proved) pendingLockProofs.delete(key); });
    pendingLockProofs.set(key, proved);
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), options.timeoutMs ?? LOCK_PROOF_TIMEOUT_MS); });
  try {
    return await Promise.race([proved, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Lock-holder proofs still running, by holder stamp; at most one per holder. */
const pendingLockProofs = new Map<string, Promise<boolean>>();

const OWNER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function lockHolderToken(lockContent: Buffer): string | null {
  try {
    const token = (JSON.parse(lockContent.toString("utf8")) as { token?: unknown } | null)?.token;
    return typeof token === "string" && OWNER_TOKEN.test(token) ? token : null;
  } catch { return null; }
}

/**
 * Removes a lock whose holder exited. Every waiter that read the same stale
 * lock races for one exclusive claim named by the holder's unique token, so
 * only one of them ever unlinks it. While the stale lock exists no one else
 * can acquire or remove it (its holder is gone), so the inode check before the
 * unlink only confirms the claim is still about that lock. Every lock and
 * claim inode is pinned by a kept owner file, so it is never reused while a
 * delayed waiter may compare against it, and a waiter that read the stale
 * lock late finds the claim and does nothing. A claim is itself a lock with a token and controller: when its
 * claimer provably exited before finishing, the same rule releases the claim
 * and the next poll claims the stale lock again.
 */
export async function releaseExitedRuntimeSkillCacheLock(root: string, lock: string,
  stale: { inode: number; token: string }, depth = 0): Promise<void> {
  const claim = `${lock}.released-${stale.token}`;
  // Publish the claim the way a lock is published: write a complete owner
  // file, then hard-link it into place, so a claim name never exists without
  // its body. The owner file is kept: it pins the claim's inode, so a deleted
  // claim's inode is never reused by a newer claim that a delayed waiter
  // might then compare against.
  const claimToken = randomUUID();
  const claimOwner = path.join(root, `.owner-${claimToken}`);
  await fs.writeFile(claimOwner, JSON.stringify({ token: claimToken, controller: currentControllerProcessStamp() }), { flag: "wx" });
  try {
    await fs.link(claimOwner, claim);
  } catch (error) {
    await fs.unlink(claimOwner).catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Bounded: a claimer crash inside this two-syscall window is already rare.
    if (depth >= 2) return;
    const handle = await fs.open(claim, constants.O_RDONLY | constants.O_NOFOLLOW).catch((openError: NodeJS.ErrnoException) => {
      if (openError.code === "ENOENT") return null;
      throw openError;
    });
    if (!handle) return;
    let held: { content: Buffer; inode: number };
    try { held = { content: await handle.readFile(), inode: (await handle.stat()).ino }; }
    finally { await handle.close(); }
    const heldToken = lockHolderToken(held.content);
    if (heldToken && await runtimeSkillCacheLockHolderExited(held.content)) {
      await releaseExitedRuntimeSkillCacheLock(root, claim, { inode: held.inode, token: heldToken }, depth + 1);
    }
    return;
  }
  const current = await fs.lstat(lock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current?.ino === stale.inode) await fs.unlink(lock);
}

// Serialize builds and cleanup for one skill across processes as well as callers.
// A hard link publishes complete lock ownership atomically. A lock whose holder
// provably exited is released at once; any other holder is waited for.
async function publishLocked<T>(root: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, `${fingerprint}.lock`);
  const token = randomUUID();
  const owner = path.join(root, `.owner-${token}`);
  // `pid` and `host` stay for older readers; `controller` is the proof input.
  // The stamp does no I/O, so preparation adds no wait before the turn.
  await fs.writeFile(owner, JSON.stringify({ pid: process.pid, host: os.hostname(), token,
    controller: currentControllerProcessStamp() }), { flag: "wx" });
  let acquired = false;
  // A live holder is re-proved at most once a second, not on every 20 ms poll.
  let judged: { inode: number; at: number } | null = null;
  try {
    const deadline = Date.now() + 60_000;
    while (!acquired) {
      try { await fs.link(owner, lock); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const handle = await fs.open(lock, constants.O_RDONLY | constants.O_NOFOLLOW).catch((openError: NodeJS.ErrnoException) => {
          if (openError.code === "ENOENT") return null;
          throw openError;
        });
        if (!handle) continue;
        let held: { content: Buffer; inode: number };
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error("Unsafe runtime skill cache file");
          held = { content: await handle.readFile(), inode: stat.ino };
        } finally { await handle.close(); }
        const holderToken = lockHolderToken(held.content);
        const due = judged === null || judged.inode !== held.inode || Date.now() - judged.at >= 1_000;
        if (holderToken && due) {
          judged = { inode: held.inode, at: Date.now() };
          if (await runtimeSkillCacheLockHolderExited(held.content,
            { timeoutMs: Math.max(1, Math.min(LOCK_PROOF_TIMEOUT_MS, deadline - Date.now())) })) {
            await releaseExitedRuntimeSkillCacheLock(root, lock, { inode: held.inode, token: holderToken });
            continue;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Runtime skill cache publisher is busy; retry preparation. If no server process holds ${lock}, remove it.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return await action();
  } finally {
    if (acquired) await fs.unlink(lock).catch(() => {});
    await fs.unlink(owner).catch(() => {});
  }
}

async function setTreeMode(directory: string, readonly: boolean): Promise<void> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (readonly && stat.isFile()) await fs.chmod(directory, 0o444);
    return;
  }
  if (!readonly) await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory)) await setTreeMode(path.join(directory, entry), readonly);
  if (readonly) await fs.chmod(directory, 0o555);
}

// Darwin requires a directory being renamed to be writable by its owner.
// Change only the directory itself, while the publication lock is held; the
// contents remain read-only. Restore the mode even when publication fails.
async function renameCacheDirectory(source: string, destination: string) {
  const stat = await fs.lstat(source);
  const directory = stat.isDirectory() && !stat.isSymbolicLink();
  if (directory) await fs.chmod(source, 0o700);
  let moved = false;
  try { await fs.rename(source, destination); moved = true; }
  finally { if (directory) await fs.chmod(moved ? destination : source, stat.mode & 0o777); }
}

async function removeTree(directory: string): Promise<void> {
  await setTreeMode(directory, false);
  await fs.rm(directory, { recursive: true, force: true });
}

export async function resolveRuntimeSkillCache(
  spec: CacheSpec, read: (relativePath: string) => Promise<string>, materialize = true,
  stillInstalled: () => Promise<boolean> = async () => true,
): Promise<string | null> {
  if (await matches(spec)) return path.join(spec.entry, "files");
  if (!materialize) return null;
  const active = inFlight.get(spec.entry);
  if (active) return active;
  const build = (async () => {
    const namespace = path.dirname(spec.root);
    await assertDirectories(namespace, path.dirname(namespace), true);
    // The lock lives outside the skill directory, so cleanup cannot unlink an active lock.
    return publishLocked(namespace, path.basename(spec.root), async () => {
      if (!await stillInstalled()) throw new Error("Skill was renamed or removed during preparation");
      await assertDirectories(spec.root, path.dirname(namespace), true);
      if (await matches(spec)) return path.join(spec.entry, "files");
      const staging = await fs.mkdtemp(path.join(spec.root, ".staging-"));
      try {
        await fs.mkdir(path.join(staging, "files"));
        const files: FileRecord[] = [];
        for (const relative of spec.paths) {
          const content = Buffer.from(await read(relative), "utf8");
          const target = path.join(staging, "files", relative);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content, { flag: "wx" });
          files.push({ path: relative, size: content.length, digest: digest(content) });
        }
        await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify({ format: FORMAT, fingerprint: spec.fingerprint, files }));
        await setTreeMode(staging, true);
        if (!await matches(spec, staging)) throw new Error("Runtime skill cache validation failed");
        // Lifecycle mutations can update the DB while this builder owns the filesystem lock.
        if (!await stillInstalled()) throw new Error("Skill was renamed or removed during preparation");
        await renameCacheDirectory(spec.entry, path.join(spec.root, `.invalid-${spec.fingerprint}-${randomUUID()}`))
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        await renameCacheDirectory(staging, spec.entry);
        return path.join(spec.entry, "files");
      } finally { await removeTree(staging); }
    });
  })();
  inFlight.set(spec.entry, build);
  try { return await build; } finally { if (inFlight.get(spec.entry) === build) inFlight.delete(spec.entry); }
}

export async function removeRuntimeSkillCache(
  managedRoot: string, skillId: string, afterRemove?: () => Promise<void>,
): Promise<void> {
  const root = runtimeSkillCacheRoot(managedRoot, skillId);
  const namespace = path.dirname(root);
  try { await assertDirectories(namespace, managedRoot, Boolean(afterRemove)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !afterRemove) return; throw error; }
  await publishLocked(namespace, skillId, async () => {
    try {
      await assertDirectories(root, managedRoot);
      await removeTree(root);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Commit deletion while builders remain excluded. Lock/cleanup failures leave the row intact.
    await afterRemove?.();
  });
}
