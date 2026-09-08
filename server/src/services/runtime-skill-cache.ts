import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CompanySkill } from "@paperclipai/shared";

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

// Serialize builds and cleanup for one skill across processes as well as callers.
// A hard link publishes complete lock ownership atomically; crashed owners are reported without stealing another publisher’s lock.
async function publishLocked<T>(root: string, fingerprint: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, `${fingerprint}.lock`);
  const owner = path.join(root, `.owner-${randomUUID()}`);
  await fs.writeFile(owner, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: "wx" });
  let acquired = false;
  try {
    const deadline = Date.now() + 60_000;
    while (!acquired) {
      try { await fs.link(owner, lock); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lockContent = await readRegularFile(lock).catch((readError: NodeJS.ErrnoException) => {
          if (readError.code === "ENOENT") return null;
          throw readError;
        });
        if (!lockContent) continue;
        const holder = JSON.parse(lockContent.toString("utf8"));
        if (holder.host === os.hostname() && Number.isSafeInteger(holder.pid) && holder.pid > 0) {
          try { process.kill(holder.pid, 0); }
          catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
              throw new Error("Runtime skill cache publisher exited; remove its stale publication lock before retrying");
            }
          }
        }
        if (Date.now() >= deadline) throw new Error("Runtime skill cache publisher is busy; retry preparation");
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
        await fs.rename(spec.entry, path.join(spec.root, `.invalid-${spec.fingerprint}-${randomUUID()}`))
          .catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        await fs.rename(staging, spec.entry);
        return path.join(spec.entry, "files");
      } finally { await removeTree(staging); }
    });
  })();
  inFlight.set(spec.entry, build);
  try { return await build; } finally { if (inFlight.get(spec.entry) === build) inFlight.delete(spec.entry); }
}

export async function removeRuntimeSkillCache(managedRoot: string, skillId: string): Promise<void> {
  const root = runtimeSkillCacheRoot(managedRoot, skillId);
  const namespace = path.dirname(root);
  try { await assertDirectories(namespace, managedRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await publishLocked(namespace, skillId, async () => {
    try { await assertDirectories(root, managedRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await removeTree(root);
  });
}
