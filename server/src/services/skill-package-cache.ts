import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { companySkillRepositorySnapshots as snapshots, type Db } from "@paperclipai/db";
import { ensureSkillCacheDirectory } from "./skill-version-cache.js";

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGES = 64;
const used = new Map<string, number>();
export function touchSkillPackage(directory: string) {
  if (used.size >= 4096) used.delete(used.keys().next().value!);
  used.set(directory, Date.now());
}

/** Called only after a cold fill, under the company cache lock. Never on a warm
 * check. Version projections and run pins have their own existing retention. */
export async function trimSkillPackageCache(db: Db, companyId: string, directory: string,
  verifyDurable: (id: string, signal: AbortSignal) => Promise<boolean>,
  removeVerified: (action: () => Promise<void>) => Promise<void> = action => action(), cancellation?: AbortSignal) {
  cancellation?.throwIfAborted();
  const parent = path.dirname(directory);
  await ensureSkillCacheDirectory(parent);
  const contents = await fs.readdir(parent, { withFileTypes: true });
  for (const entry of contents) {
    if (!/^\.(package|upload|verify)-[a-zA-Z0-9]{6}(\.tar\.gz)?$/.test(entry.name)) continue;
    const target = path.join(parent, entry.name);
    // Every I/O attempt has a three-minute deadline; leave a much longer crash
    // grace so housekeeping cannot race a live publisher in another process.
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (stat && Date.now() - stat.mtimeMs > 60 * 60_000) await fs.rm(target, { recursive: true, force: true });
  }
  const names = contents.filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name)).map(entry => entry.name);
  if (!names.length) return;
  const rows = await db.select({ id: snapshots.id, storage: snapshots.storage }).from(snapshots)
    .where(and(eq(snapshots.companyId, companyId), inArray(snapshots.id, names)));
  const byId = new Map(rows.map(row => [row.id, row.storage]));
  const candidates = await Promise.all(names.map(async id => {
    const location = path.join(parent, id);
    const receipt = byId.get(id);
    const stat = await fs.lstat(location).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!stat) return null;
    return { id, location, receipt, lastUsed: used.get(location) ?? stat.mtimeMs,
      // Include an upper bound on block rounding and directory/manifest overhead.
      bytes: receipt ? receipt.totalBytes + receipt.fileCount * 8192 : 64 * 1024 * 1024 };
  }));
  const entries = candidates.filter(entry => entry !== null);
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let count = entries.length;
  const timeout = AbortSignal.timeout(10_000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  let attempted = 0;
  for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (bytes <= MAX_BYTES && count <= MAX_PACKAGES) break;
    if (signal.aborted || attempted >= 2) break;
    if (entry.location === directory) continue;
    attempted++;
    // A storage outage must not discard the last recoverable copy. Keep the
    // excess until the next cold fill can confirm a durable copy independently.
    if (byId.has(entry.id) && !await verifyDurable(entry.id, signal)) break;
    let removed = false;
    await removeVerified(async () => {
      if ((used.get(entry.location) ?? entry.lastUsed) > entry.lastUsed) return;
      await fs.rm(entry.location, { recursive: true, force: true });
      await fs.rm(path.join(parent, `${entry.id}.json`), { force: true });
      used.delete(entry.location);
      removed = true;
    });
    if (!removed) continue;
    bytes -= entry.bytes;
    count--;
  }
}
