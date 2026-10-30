import { promises as fs } from "node:fs";
import path from "node:path";

// Revalidate the complete path on reuse, including symlink identities/targets.
// Moving an unchanged leaf to a new parent must invalidate its durability proof.
const durableDirectories = new Map<string, string>();

export async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function directoryAncestry(directory: string) {
  // The configured path must also be traversable by the OS for later writes,
  // including its native symlink-depth limit.
  await fs.stat(directory);
  let current = path.parse(directory).root;
  let pending = directory.slice(current.length).split(path.sep);
  const directories = new Set([current]);
  const identities: string[] = [];
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift()!;
    if (!part || part === ".") continue;
    if (part === "..") { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    const stat = await fs.lstat(next, { bigint: true });
    identities.push(`${next}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
    if (stat.isSymbolicLink()) {
      if (++links > 40) throw Object.assign(new Error("Too many storage symlinks"), { code: "ELOOP" });
      const target = await fs.readlink(next);
      identities.push(target);
      // Resolve target components in filesystem order. Normalizing a target
      // like "link/../home" before following link would select the wrong home.
      if (path.isAbsolute(target)) current = path.parse(target).root;
      pending = target.split(path.sep).concat(pending);
    } else {
      if (!stat.isDirectory()) throw Object.assign(new Error("Storage path is not a directory"), { code: "ENOTDIR" });
      current = next;
      directories.add(current);
    }
  }
  return { directories: [...directories].reverse(), identity: JSON.stringify(identities) };
}

/** An existing directory may be left by an interrupted mkdir/flush sequence.
 * A fresh process must flush its complete ancestry before trusting it. Never
 * waive a permission error based on an in-memory creation boundary: a restart
 * would forget that boundary and could acknowledge a non-durable token write. */
export async function ensureDurableDirectory(directory: string) {
  const resolved = path.resolve(directory);
  if (process.platform === "win32") {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    return;
  }
  let ancestry = await directoryAncestry(resolved).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  if (!ancestry) {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
    ancestry = await directoryAncestry(resolved);
  }
  if (durableDirectories.get(resolved) === ancestry.identity) return;
  for (const parent of ancestry.directories) await syncDirectory(parent);
  // Cache only a fully flushed path. Failures, siblings and fresh processes
  // each retry the entire chain rather than inferring durability from existence.
  if (durableDirectories.size >= 1024) durableDirectories.delete(durableDirectories.keys().next().value!);
  durableDirectories.set(resolved, ancestry.identity);
}
