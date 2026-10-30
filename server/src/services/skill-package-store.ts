import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { recoverSkillPackage, skillPackageRecoveryReader } from "./skill-package-recovery.js";
import { touchSkillPackage, trimSkillPackageCache } from "./skill-package-cache.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { companySkillRepositorySnapshots as snapshots, companySkillVersions, companySkillSources, withDedicatedDbConnection, type Db, type SkillPackageFileMapping, type SkillPackageStorageReceipt, type SkillPackageRestoreRecipe } from "@paperclipai/db";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { getStorageService, type StorageService } from "../storage/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, notFound } from "../errors.js";
import { assertSkillSnapshotPath, skillFileBytes } from "./skill-snapshot.js";
import { ensureSkillCacheDirectory, SkillCacheBusy, withSkillVersionCacheLock } from "./skill-version-cache.js";
import { boundedHashStream, extractSkillPackageArchive, MAX_SKILL_MANIFEST_BYTES, packageSha256,
  skillPackageManifest, skillPackageManifestBytes, validateSkillPackageManifest, verifySkillPackageDirectory, relocateSkillPackageVerification, writeSkillPackageArchive,
  type SkillPackageManifest } from "./skill-package-files.js";

/** External storage is the default; false is an explicit rolling-upgrade escape hatch. */
export function skillPackageStorageEnabled() {
  return process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED !== "false";
}

const descriptorColumns = { id: snapshots.id, companyId: snapshots.companyId, contentHash: snapshots.contentHash,
  storage: snapshots.storage, upload: snapshots.upload, createdAt: snapshots.createdAt,
  restorable: sql<boolean>`${snapshots.restore} is not null`, restoreRetryAt: snapshots.restoreRetryAt };
type Descriptor = Pick<typeof snapshots.$inferSelect, "id" | "companyId" | "contentHash" | "storage" | "upload" | "createdAt" | "restoreRetryAt"> & { restorable: boolean };
export const skillVersionMetadataColumns = { ...getTableColumns(companySkillVersions),
  fileInventory: sql<CompanySkillVersionFileInventoryEntry[]>`'[]'::jsonb` };
export type StoredSkillVersion = typeof companySkillVersions.$inferSelect;
export function skillVersionFileMap(files: CompanySkillVersionFileInventoryEntry[], manifest: SkillPackageManifest): SkillPackageFileMapping[] | null {
  const stored = new Map(manifest.files.map(file => [file.path, file]));
  if (files.every(file => stored.get(file.path)?.kind === file.kind && stored.get(file.path)?.encoding === (file.encoding ?? "utf8"))) return null;
  return files.map(file => ({ path: file.path, sourcePath: file.path, kind: file.kind, encoding: file.encoding ?? "utf8" }));
}
type ReadScope = { db: Db; descriptors: Map<string, Promise<Descriptor>>; durable: Map<string, Promise<boolean>>; versions: Map<string, StoredSkillVersion> };
const readScope = new AsyncLocalStorage<ReadScope>();
export function withSkillPackageReadScope<T>(db: Db, action: () => Promise<T>): Promise<T> {
  return readScope.getStore()?.db === db ? action() : readScope.run({ db, descriptors: new Map(), durable: new Map(), versions: new Map() }, action);
}
const flights = new WeakMap<Db, Map<string, Promise<unknown>>>();
function flight<T>(db: Db, key: string, action: () => Promise<T>): Promise<T> {
  let pending = flights.get(db);
  if (!pending) { pending = new Map(); flights.set(db, pending); }
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const work = action().finally(() => pending!.delete(key));
  pending.set(key, work);
  return work;
}
type SharedFlight = { work: Promise<unknown>; controller: AbortController; waiters: number };
const sharedFlights = new WeakMap<Db, Map<string, SharedFlight>>();
function sharedFlight<T>(db: Db, key: string, cancellation: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  cancellation?.throwIfAborted();
  let pending = sharedFlights.get(db);
  if (!pending) { pending = new Map(); sharedFlights.set(db, pending); }
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters: 0, work: Promise.resolve() };
    const created = entry;
    entry.work = action(controller.signal).finally(() => {
      if (pending!.get(key) === created) pending!.delete(key);
    });
    pending.set(key, entry);
  }
  const current = entry;
  current.waiters++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return false;
      settled = true;
      cancellation?.removeEventListener("abort", aborted);
      current.waiters--;
      return true;
    };
    const aborted = () => {
      if (!release()) return;
      if (current.waiters) { reject(cancellation!.reason); return; }
      if (pending!.get(key) === current) pending!.delete(key);
      current.controller.abort(cancellation!.reason);
      // The last caller owns cancellation and waits for storage/queue cleanup.
      void current.work.then(() => reject(cancellation!.reason), () => reject(cancellation!.reason));
    };
    cancellation?.addEventListener("abort", aborted, { once: true });
    current.work.then(value => { if (release()) resolve(value as T); }, error => { if (release()) reject(error); });
  });
}
type PackageIoQueue = { active: number; waiting: Array<() => void> };
const storageIo: PackageIoQueue = { active: 0, waiting: [] };
// A decoded cold response remains owned until its post-fill cleanup finishes.
const coldResponses: PackageIoQueue = { active: 0, waiting: [] };
// Bound local response buffers independently so stalled storage does not prevent
// verified cached reads, including reads inside an existing DB transaction.
const inventoryIo: PackageIoQueue = { active: 0, waiting: [] };
async function withPackageIo<T>(action: () => Promise<T>, signal: AbortSignal, queue = storageIo): Promise<T> {
  signal.throwIfAborted();
  if (queue.active >= 2) {
    if (queue.waiting.length >= 32) throw conflict("Skill package storage is busy; retry shortly.");
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener("abort", aborted); resolve(); };
      const aborted = () => {
        const index = queue.waiting.indexOf(ready);
        if (index >= 0) queue.waiting.splice(index, 1);
        reject(signal.reason);
      };
      queue.waiting.push(ready);
      signal.addEventListener("abort", aborted, { once: true });
    });
  } else queue.active++;
  try { signal.throwIfAborted(); return await action(); }
  finally { const next = queue.waiting.shift(); if (next) next(); else queue.active--; }
}
const manifests = new Map<string, { manifest: SkillPackageManifest; bytes: number }>();
let manifestBytes = 0;
const MAX_MANIFEST_CACHE = 16 * 1024 * 1024;
function rememberManifest(key: string, manifest: SkillPackageManifest, bytes: number) {
  if (bytes > MAX_MANIFEST_CACHE) return;
  const previous = manifests.get(key);
  if (previous) manifestBytes -= previous.bytes;
  manifests.delete(key);
  while (manifests.size && manifestBytes + bytes > MAX_MANIFEST_CACHE) {
    const first = manifests.keys().next().value!;
    manifestBytes -= manifests.get(first)!.bytes;
    manifests.delete(first);
  }
  manifests.set(key, { manifest, bytes });
  manifestBytes += bytes;
}
export function skillPackagePaths(companyId: string, snapshotId: string) {
  if (![companyId, snapshotId].every(id => /^[a-f0-9-]{36}$/i.test(id))) throw new Error("Invalid skill package identity");
  const parent = path.join(resolvePaperclipInstanceRoot(), "skills", companyId, "__packages__");
  return { parent, directory: path.join(parent, snapshotId), manifest: path.join(parent, `${snapshotId}.json`) };
}
async function readBoundedObject(storage: StorageService, companyId: string, key: string, length: number, hash: string, signal: AbortSignal) {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SKILL_MANIFEST_BYTES) throw new Error("Invalid skill manifest size");
  const object = await storage.getObject(companyId, key, { signal });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of object.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > length) throw new Error("Skill manifest exceeds its recorded size");
      chunks.push(buffer);
    }
  } finally { object.stream.destroy(); }
  const result = Buffer.concat(chunks);
  if (bytes !== length || packageSha256(result) !== hash) throw new Error("Skill manifest checksum mismatch");
  return result;
}

/** Owns immutable package storage. Authorization belongs to the referencing
 * skill/source, and must be checked even when package bytes are already cached.
 * Transaction readers supply their originating DB as cacheOwner for dedicated
 * cache locks; metadata queries remain on the caller's transaction. */
export function skillPackageStore(db: Db, suppliedStorage?: StorageService, cacheOwner: Db = db) {
  const storage = () => suppliedStorage ?? getStorageService();
  const scope = (companyId: string, id: string) => and(eq(snapshots.companyId, companyId), eq(snapshots.id, id));
  async function descriptor(companyId: string, id: string): Promise<Descriptor> {
    const load = async () => {
      const [row] = await db.select(descriptorColumns).from(snapshots).where(scope(companyId, id));
      if (!row || (!row.storage && !row.restorable && row.upload && !row.upload.legacy)) throw notFound("Installed skill package is unavailable");
      return row;
    };
    const context = readScope.getStore();
    if (context?.db !== db) return load();
    const key = `${companyId}:${id}`;
    if (!context.descriptors.has(key)) context.descriptors.set(key, load());
    return context.descriptors.get(key)!;
  }
  async function version(companyId: string, skillId: string, id: string): Promise<StoredSkillVersion | null> {
    const context = readScope.getStore();
    const cached = context?.db === db ? context.versions.get(`${companyId}:${id}`) : null;
    if (cached) return cached.companySkillId === skillId ? cached : null;
    const [row] = await db.select(skillVersionMetadataColumns).from(companySkillVersions).where(and(
      eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, skillId), eq(companySkillVersions.id, id)));
    return row ?? null;
  }
  async function prefetch(companyId: string, versionIds: string[]) {
    const context = readScope.getStore();
    if (context?.db !== db || versionIds.length < 2) return;
    const rows = await db.select(skillVersionMetadataColumns).from(companySkillVersions).where(and(
      eq(companySkillVersions.companyId, companyId), inArray(companySkillVersions.id, [...new Set(versionIds)])));
    for (const row of rows) context.versions.set(`${companyId}:${row.id}`, row);
    const ids = [...new Set(rows.flatMap(row => [row.repositorySnapshotId, row.packageSnapshotId]).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return;
    const packages = await db.select(descriptorColumns).from(snapshots).where(and(eq(snapshots.companyId, companyId), inArray(snapshots.id, ids)));
    for (const row of packages) if (row.storage || row.restorable || !row.upload || row.upload.legacy) {
      context.descriptors.set(`${companyId}:${row.id}`, Promise.resolve(row));
    }
  }
  async function restoreRecipe(row: Descriptor, database = db) {
    const [saved] = await database.select({ restore: snapshots.restore }).from(snapshots).where(scope(row.companyId, row.id));
    const recipe = saved?.restore;
    if (!recipe || recipe.version !== 1) throw notFound("This skill package has no exact-commit restore recipe");
    const manifest = validateSkillPackageManifest(recipe.manifest);
    if (manifest.contentHash !== row.contentHash || (row.storage && packageSha256(skillPackageManifestBytes(manifest)) !== row.storage.manifestSha256)) {
      throw new Error("Skill package restore recipe does not match its receipt");
    }
    return recipe;
  }
  async function acquireFiles(row: Descriptor, signal: AbortSignal, database = db) {
    signal.throwIfAborted();
    const [current] = await database.select({ retryAt: snapshots.restoreRetryAt }).from(snapshots).where(scope(row.companyId, row.id));
    if (current?.retryAt && current.retryAt.getTime() > Date.now()) throw conflict("The original skill package could not be acquired. Reconnect its repository and retry after the recovery backoff.");
    try {
      const recipe = await restoreRecipe(row, database);
      const read = await skillPackageRecoveryReader(database, row.companyId, recipe);
      const files = await recoverSkillPackage(recipe, read, signal);
      await database.update(snapshots).set({ restoreRetryAt: null }).where(scope(row.companyId, row.id));
      return files;
    } catch (error) {
      if (!signal.aborted) await database.update(snapshots).set({ restoreRetryAt: new Date(Date.now() + 5 * 60_000) }).where(scope(row.companyId, row.id));
      throw error;
    }
  }
  async function legacyFiles(row: Descriptor, database = db) {
    const [legacy] = await database.select({ files: snapshots.fileInventory, storage: snapshots.storage, upload: snapshots.upload })
      .from(snapshots).where(scope(row.companyId, row.id));
    if (!legacy || (!legacy.files.length && !legacy.storage)) throw notFound("Installed skill package has no saved contents");
    // A reader may have loaded its descriptor just before a migration clears
    // the legacy payload. Upgrade this request's descriptor to the published
    // receipt instead of reporting a missing historical version.
    if (legacy.storage) { row.storage = legacy.storage; row.upload = legacy.upload; }
    return legacy.files;
  }
  async function manifestFor(row: Descriptor, cancellation?: AbortSignal): Promise<SkillPackageManifest> {
    cancellation?.throwIfAborted();
    const paths = skillPackagePaths(row.companyId, row.id);
    const key = `${paths.manifest}:${row.storage?.manifestSha256 ?? row.contentHash}`;
    const cached = manifests.get(key);
    if (cached) return cached.manifest;
    const load = async (sharedSignal: AbortSignal) => {
      const signal = AbortSignal.any([sharedSignal, AbortSignal.timeout(180_000)]);
      await ensureSkillCacheDirectory(paths.parent, true);
      // Legacy manifests have no independently stored checksum. Derive them once
      // per process from the authoritative row until the operator migrates it.
      let bytes: Buffer | null = null;
      if (row.storage) {
        try {
          const file = await fs.open(paths.manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await file.stat();
            if (stat.isFile() && stat.size <= MAX_SKILL_MANIFEST_BYTES) bytes = await file.readFile();
          } finally { await file.close(); }
        } catch (error) {
          if (!["ENOENT", "ELOOP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      if (row.storage) {
        if (!bytes || packageSha256(bytes) !== row.storage.manifestSha256) {
          try {
            if (row.storage.provider !== storage().provider) throw new Error("Skill package storage provider changed");
            bytes = await withPackageIo(() => readBoundedObject(storage(), row.companyId, row.storage!.manifestKey,
              row.storage!.manifestBytes, row.storage!.manifestSha256, signal), signal);
          } catch (error) {
            signal.throwIfAborted();
            const saved = await withPackageIo(() => withDedicatedDbConnection(cacheOwner, async database => {
              const [legacy] = await database.select({ files: snapshots.fileInventory }).from(snapshots).where(scope(row.companyId, row.id));
              return legacy?.files.length ? skillPackageManifestBytes(skillPackageManifest(legacy.files)) : null;
            }), signal);
            if (saved && packageSha256(saved) === row.storage!.manifestSha256) bytes = saved;
            else if (row.restorable) bytes = skillPackageManifestBytes((await restoreRecipe(row)).manifest);
            else throw error;
          }
        }
      } else if (row.restorable) {
        bytes = skillPackageManifestBytes((await restoreRecipe(row)).manifest);
      } else if (!bytes) {
        bytes = await withPackageIo(() => withDedicatedDbConnection(cacheOwner, async database => {
          const files = await legacyFiles(row, database);
          return row.storage ? null : skillPackageManifestBytes(skillPackageManifest(files));
        }), signal);
        if (!bytes) return manifestFor(row, signal);
      }
      signal.throwIfAborted();
      if (bytes.length > MAX_SKILL_MANIFEST_BYTES) throw new Error("Skill manifest exceeds its byte bound");
      const manifest = validateSkillPackageManifest(JSON.parse(bytes.toString("utf8")));
      if (row.storage && (manifest.contentHash !== row.contentHash || manifest.files.length !== row.storage.fileCount
        || manifest.totalBytes !== row.storage.totalBytes)) throw new Error("Skill package receipt does not match its manifest");
      await ensureSkillCacheDirectory(paths.parent, true);
      const temp = `${paths.manifest}.${randomUUID()}`;
      try { await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600, signal }); signal.throwIfAborted(); await fs.rename(temp, paths.manifest); }
      finally { await fs.rm(temp, { force: true }); }
      rememberManifest(key, manifest, bytes.length);
      return manifest;
    };
    return sharedFlight(db, `manifest:${key}`, cancellation, load);
  }
  async function restoreInto(row: Descriptor, manifest: SkillPackageManifest, staging: string,
    archivePath: string, signal: AbortSignal, allowRecovery = true, database = db) {
    let legacy: CompanySkillVersionFileInventoryEntry[] | null = null;
    if (!row.storage && !row.restorable) legacy = await legacyFiles(row, database);
    try {
      if (row.storage) {
        if (row.storage.provider !== storage().provider) throw new Error("Skill package storage provider changed");
        const object = await storage().getObject(row.companyId, row.storage.archiveKey, { signal });
        const digest = boundedHashStream(row.storage.archiveBytes);
        await pipeline(object.stream, digest.stream, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }), { signal });
        const actual = digest.result();
        if (actual.bytes !== row.storage.archiveBytes || actual.sha256 !== row.storage.archiveSha256) throw new Error("Skill package archive checksum mismatch");
        await extractSkillPackageArchive(archivePath, staging, manifest, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      // A missing/corrupt archive must not hide a still-authoritative legacy
      // body. Only then use the saved, authorized immutable Git recipe.
      const [saved] = await database.select({ files: snapshots.fileInventory }).from(snapshots).where(scope(row.companyId, row.id));
      if (saved?.files.length && skillPackageManifest(saved.files).contentHash === row.contentHash) legacy = saved.files;
      else if (row.restorable && allowRecovery) legacy = await acquireFiles(row, signal, database);
      else throw error;
      await fs.rm(staging, { recursive: true, force: true });
      await fs.mkdir(staging);
    }
    if (!row.storage && row.restorable && !legacy) {
      if (!allowRecovery) throw notFound("Skill package bytes are not stored");
      legacy = await acquireFiles(row, signal, database);
    }
    if (legacy) {
      for (const file of legacy) {
        signal.throwIfAborted();
        const target = path.join(staging, assertSkillSnapshotPath(file.path));
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, skillFileBytes(file), { flag: "wx", mode: file.executable ? 0o555 : 0o444 });
      }
    }
    if (!await verifySkillPackageDirectory(staging, manifest.files)) throw new Error("Restored skill package does not match its manifest");
  }
  // Archive reads and verification own private scratch space outside the warm
  // preparation lock. Administrative reads briefly try that lock to publish.
  async function withIsolatedPackage<T>(companyId: string, id: string,
    consume: (root: string, manifest: SkillPackageManifest) => Promise<T>, allowRecovery = true, cancellation?: AbortSignal, cacheRead = false) {
    const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    signal.throwIfAborted();
    // Preserve the caller's transaction view before taking an I/O permit. All
    // later SQL uses a private connection, so a queued transaction cannot hold
    // the ordinary pool connection needed by an active cold response.
    const row = await descriptor(companyId, id);
    const manifest = await manifestFor(row, signal);
    const read = () => withDedicatedDbConnection(cacheOwner, database =>
      readIsolatedPackage(row, manifest, consume, allowRecovery, signal, cacheRead, database));
    return cacheRead ? withPackageIo(read, signal, coldResponses) : read();
  }
  async function readIsolatedPackage<T>(row: Descriptor, manifest: SkillPackageManifest,
    consume: (root: string, manifest: SkillPackageManifest) => Promise<T>, allowRecovery: boolean, signal: AbortSignal, cacheRead: boolean,
    database: Db) {
    const { companyId, id } = row;
    let published = false;
    const result = await withPackageIo(async () => {
      const parent = skillPackagePaths(companyId, id).parent;
      await ensureSkillCacheDirectory(parent, true);
      const staging = await fs.mkdtemp(path.join(parent, ".verify-"));
      const archive = `${staging}.tar.gz`;
      try {
        await restoreInto(row, manifest, staging, archive, signal, allowRecovery, database);
        const result = await consume(staging, manifest);
        if (cacheRead) {
          // Network, extraction, hashing and response reads all happen before
          // this short publication lock. Busy preparation keeps its priority.
          const paths = skillPackagePaths(companyId, id);
          const previous = await fs.mkdtemp(path.join(parent, ".verify-"));
          try {
            await withSkillVersionCacheLock(cacheOwner, companyId, async () => {
              let moved = false;
              try { await fs.rename(paths.directory, previous); moved = true; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
              try { await fs.rename(staging, paths.directory); }
              catch (error) { if (moved) await fs.rename(previous, paths.directory); throw error; }
              relocateSkillPackageVerification(staging, paths.directory, manifest.files);
              touchSkillPackage(paths.directory);
              published = true;
            }, true);
          } catch (error) { if (!(error instanceof SkillCacheBusy)) throw error; }
          finally { await fs.rm(previous, { recursive: true, force: true }); }
        }
        return result;
      } finally { await fs.rm(staging, { recursive: true, force: true }); await fs.rm(archive, { force: true }); }
    }, signal);
    if (published) {
      // Verify possible eviction candidates outside both the preparation lock
      // and the storage slot used for this fill; take the lock only to remove.
      const reader = skillPackageStore(database, storage(), cacheOwner);
      await trimSkillPackageCache(database, companyId, skillPackagePaths(companyId, id).directory,
        (id, signal) => reader.verifyDurable(companyId, id, signal).catch(() => false),
        async remove => {
          try { await withSkillVersionCacheLock(cacheOwner, companyId, remove, true); }
          catch (error) { if (!(error instanceof SkillCacheBusy)) throw error; }
        }, signal);
    }
    signal.throwIfAborted();
    return result;
  }
  async function materialize(row: Descriptor, manifest: SkillPackageManifest) {
    const paths = skillPackagePaths(row.companyId, row.id);
    return flight(db, `files:${paths.directory}`, async () => {
      await ensureSkillCacheDirectory(paths.parent, true);
      if (await verifySkillPackageDirectory(paths.directory, manifest.files)) return { directory: paths.directory, created: false };
      const signal = AbortSignal.timeout(180_000);
      return withPackageIo(async () => {
        const staging = await fs.mkdtemp(path.join(paths.parent, ".package-"));
        const archivePath = `${staging}.tar.gz`;
        try {
          await restoreInto(row, manifest, staging, archivePath, signal);
          // All consumers hold the company cache lock, including processes sharing a volume.
          await fs.rm(paths.directory, { recursive: true, force: true });
          await fs.rename(staging, paths.directory);
          relocateSkillPackageVerification(staging, paths.directory, manifest.files);
          return { directory: paths.directory, created: true };
        } finally { await fs.rm(staging, { recursive: true, force: true }); await fs.rm(archivePath, { force: true }); }
      }, signal);
    });
  }
  async function withPackage<T>(companyId: string, id: string, consume: (root: string, manifest: SkillPackageManifest) => Promise<T>) {
    const row = await descriptor(companyId, id);
    const manifest = await manifestFor(row);
    return withSkillVersionCacheLock(db, companyId, async () => {
      const restored = await materialize(row, manifest);
      touchSkillPackage(restored.directory);
      if (restored.created) await trimSkillPackageCache(db, companyId, restored.directory,
        (id, signal) => verifyDurable(companyId, id, signal).catch(() => false));
      return consume(restored.directory, manifest);
    });
  }
  async function files(companyId: string, id: string, isolated = false): Promise<CompanySkillVersionFileInventoryEntry[]> {
    return (isolated ? withIsolatedPackage : withPackage)(companyId, id, async (root, manifest) => {
      const result: CompanySkillVersionFileInventoryEntry[] = [];
      for (const entry of manifest.files) result.push({ path: entry.path, kind: entry.kind, content: (await fs.readFile(path.join(root, entry.path))).toString(entry.encoding),
        ...(entry.encoding === "base64" ? { encoding: entry.encoding } : {}), ...(entry.executable ? { executable: true } : {}) });
      return result;
    });
  }
  async function prepare(companyId: string, files: CompanySkillVersionFileInventoryEntry[], migrateLegacy = false, cancellation?: AbortSignal, restore?: SkillPackageRestoreRecipe): Promise<string> {
    cancellation?.throwIfAborted();
    const manifest = skillPackageManifest(files);
    if (restore && !skillPackageManifestBytes(restore.manifest).equals(skillPackageManifestBytes(manifest))) throw new Error("Restore recipe does not describe these package bytes");
    const preparedId = await flight(db, `prepare:${companyId}:${manifest.contentHash}`, async () => {
      const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
      const token = randomUUID();
      const prefix = `${companyId}/skill-packages/${token}`;
      const upload = { token, legacy: false, provider: storage().provider, archiveKey: `${prefix}/files.tar.gz`, manifestKey: `${prefix}/manifest.json`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
      const [created] = await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillPackages);
        return tx.insert(snapshots).values({ companyId, contentHash: manifest.contentHash, upload, restore,
          migrationAt: null, maintenanceAt: new Date(Date.now() + 24 * 60 * 60_000) }).onConflictDoNothing().returning(descriptorColumns);
      });
      let existing = created ?? (await db.select(descriptorColumns).from(snapshots).where(and(eq(snapshots.companyId, companyId), eq(snapshots.contentHash, manifest.contentHash))))[0]!;
      if (!created) {
        if (existing.storage || (!existing.upload && !migrateLegacy && !existing.restorable)) {
          // Content deduplication must not attach a recipe with different kind or
          // encoding metadata to an already published manifest.
          if (restore && !existing.restorable && existing.storage?.manifestSha256 === packageSha256(skillPackageManifestBytes(manifest))) {
            await db.update(snapshots).set({ restore }).where(and(scope(companyId, existing.id), sql`${snapshots.restore} is null`));
          }
          return existing.id;
        }
        // A stale claim is replaced atomically; the DB trigger retains its exact
        // keys in the deletion outbox. Never reuse keys from another attempt.
        upload.legacy = !existing.upload || Boolean(existing.upload.legacy);
        const [claimed] = await db.update(snapshots).set({ upload }).where(and(scope(companyId, existing.id),
          sql`${snapshots.storage} is null`,
          sql`(${snapshots.upload} is null or (${snapshots.upload}->>'expiresAt')::timestamptz <= now())`)).returning(descriptorColumns);
        if (!claimed) throw conflict("This skill package is being saved. Retry after its upload settles.");
        existing = claimed;
      }
      return withPackageIo(async () => {
        const root = skillPackagePaths(companyId, existing.id).parent;
        await ensureSkillCacheDirectory(root, true);
        const staging = await fs.mkdtemp(path.join(root, ".upload-"));
        const archivePath = path.join(staging, "files.tar.gz");
        const manifestBuffer = skillPackageManifestBytes(manifest);
        if (manifestBuffer.length > MAX_SKILL_MANIFEST_BYTES) throw new Error("Skill manifest exceeds its byte bound");
        const backend = storage();
        try {
          const archive = await writeSkillPackageArchive(archivePath, files, signal);
          await backend.putFile({ companyId, namespace: "skill-packages", objectKey: upload.archiveKey, originalFilename: "files.tar.gz",
            contentType: "application/gzip", body: createReadStream(archivePath), byteSize: archive.bytes, sha256: archive.sha256, signal });
          await backend.putFile({ companyId, namespace: "skill-packages", objectKey: upload.manifestKey, originalFilename: "manifest.json",
            contentType: "application/json", body: manifestBuffer, signal });
          const receipt: SkillPackageStorageReceipt = { format: "tar-gzip-v1", provider: backend.provider, ...(!restore ? { durable: true } : {}),
            archiveKey: upload.archiveKey, archiveSha256: archive.sha256, archiveBytes: archive.bytes,
            manifestKey: upload.manifestKey, manifestSha256: packageSha256(manifestBuffer), manifestBytes: manifestBuffer.length,
            fileCount: manifest.files.length, totalBytes: manifest.totalBytes };
          // A complete read verifies storage independently before publishing any reference.
          await readBoundedObject(backend, companyId, receipt.manifestKey, receipt.manifestBytes, receipt.manifestSha256, signal);
          const verify = await backend.getObject(companyId, receipt.archiveKey, { signal });
          const digest = boundedHashStream(receipt.archiveBytes);
          const downloaded = path.join(staging, "verified.tar.gz");
          await pipeline(verify.stream, digest.stream, createWriteStream(downloaded, { flags: "wx", mode: 0o600 }), { signal });
          const actual = digest.result();
          if (actual.bytes !== receipt.archiveBytes || actual.sha256 !== receipt.archiveSha256) throw new Error("Uploaded skill package checksum mismatch");
          const restored = path.join(staging, "restored");
          await fs.mkdir(restored);
          await extractSkillPackageArchive(downloaded, restored, manifest, signal);
          signal.throwIfAborted();
          const [saved] = await db.transaction(async tx => {
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillPackages);
            return tx.update(snapshots).set({ storage: receipt, upload: null, ...(restore ? { restore } : {}) })
              .where(and(scope(companyId, existing.id), sql`${snapshots.upload}->>'token' = ${token}`)).returning({ id: snapshots.id });
          });
          if (!saved) throw conflict("Skill package upload ownership changed");
          return saved.id;
        } finally {
          // Failed/ambiguous uploads retain their durable claim. Maintenance reconciles
          // exact owned keys; never delete a successful object on an uncertain SQL result.
          await fs.rm(staging, { recursive: true, force: true });
        }
      }, signal);
    });
    {
      const [retained] = await db.update(snapshots).set({ maintenanceAt: new Date(Date.now() + 24 * 60 * 60_000),
        ...(!restore ? { storage: sql`jsonb_set(${snapshots.storage}, '{durable}', 'true'::jsonb)` } : {}) })
        .where(and(scope(companyId, preparedId), sql`${snapshots.storage} is not null`)).returning({ id: snapshots.id });
      if (!retained) return prepare(companyId, files, true, cancellation, restore);
    }
    return preparedId;
  }
  async function bindRestore(companyId: string, id: string, restore: SkillPackageRestoreRecipe) {
    const manifest = validateSkillPackageManifest(restore.manifest);
    // Called in the source publication transaction. A failed import must not
    // leave a later successful import bound to an uncommitted source identity.
    await db.update(snapshots).set({ restore }).where(and(scope(companyId, id),
      eq(snapshots.contentHash, manifest.contentHash),
      sql`${snapshots.storage}->>'manifestSha256' = ${packageSha256(skillPackageManifestBytes(manifest))}`,
      sql`exists (select 1 from ${companySkillSources} s where s.company_id = ${companyId}
        and s.id = ${restore.sourceId} and s.removed_at is null)`,
      sql`not exists (select 1 from ${companySkillSources} s where s.company_id = ${companyId}
        and s.id::text = ${snapshots.restore}->>'sourceId' and s.removed_at is null)`));
  }
  async function verifyDurable(companyId: string, id: string, cancellation?: AbortSignal,
    validate?: (root: string, manifest: SkillPackageManifest) => Promise<boolean>): Promise<boolean> {
    const action = async () => {
      cancellation?.throwIfAborted();
      const row = await descriptor(companyId, id);
      if (!row.storage) {
        await manifestFor(row, cancellation);
        if (!row.storage) return validate ? withIsolatedPackage(companyId, id, validate, false, cancellation) : true;
      }
      if (row.storage.provider !== storage().provider) throw new Error("Skill package storage provider changed; migrate its objects before switching storage");
      const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
      return withPackageIo(async () => {
        const receipt = row.storage!;
        const bytes = await readBoundedObject(storage(), companyId, receipt.manifestKey, receipt.manifestBytes, receipt.manifestSha256, signal);
        const manifest = validateSkillPackageManifest(JSON.parse(bytes.toString("utf8")));
        if (manifest.contentHash !== row.contentHash) return false;
        const parent = skillPackagePaths(companyId, id).parent;
        await ensureSkillCacheDirectory(parent, true);
        const staging = await fs.mkdtemp(path.join(parent, ".verify-"));
        try {
          const object = await storage().getObject(companyId, receipt.archiveKey, { signal });
          const digest = boundedHashStream(receipt.archiveBytes);
          const archive = path.join(staging, "files.tar.gz");
          await pipeline(object.stream, digest.stream, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal });
          const actual = digest.result();
          if (actual.bytes !== receipt.archiveBytes || actual.sha256 !== receipt.archiveSha256) return false;
          const restored = path.join(staging, "files");
          await fs.mkdir(restored);
          await extractSkillPackageArchive(archive, restored, manifest, signal);
          return validate ? await validate(restored, manifest) : true;
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
      }, signal);
    };
    const context = readScope.getStore();
    const key = `${companyId}:${id}`;
    if (context?.db !== db || validate || cancellation) return action();
    if (!context.durable.has(key)) context.durable.set(key, action());
    return context.durable.get(key)!;
  }
  async function readPackageFile(root: string, entry: SkillPackageManifest["files"][number], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const filename = path.join(root, entry.path);
    await ensureSkillCacheDirectory(path.dirname(filename));
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== entry.size) throw new Error("Invalid cached skill file");
      const bytes = Buffer.alloc(entry.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("Invalid cached skill file");
        offset += bytesRead;
      }
      if (packageSha256(bytes) !== entry.sha256) throw new Error("Invalid cached skill file");
      return bytes;
    } finally { await handle.close(); }
  }
  async function versionFiles(version: StoredSkillVersion, allowRecovery = true, cancellation?: AbortSignal): Promise<CompanySkillVersionFileInventoryEntry[]> {
    const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
    signal.throwIfAborted();
    if (!version.packageSnapshotId) {
      const [row] = await db.select({ ...skillVersionMetadataColumns, files: companySkillVersions.fileInventory }).from(companySkillVersions).where(and(
        eq(companySkillVersions.companyId, version.companyId), eq(companySkillVersions.id, version.id)));
      if (row?.packageSnapshotId) return versionFiles(row, allowRecovery, signal);
      return row?.files ?? [];
    }
    const id = version.packageSnapshotId;
    const manifest = await manifestFor(await descriptor(version.companyId, id), signal);
    const read = async (root: string) => {
      const byPath = new Map(manifest.files.map(file => [file.path, file]));
      const result: CompanySkillVersionFileInventoryEntry[] = [];
      for (const mapping of version.packageFileMap ?? manifest.files.map(file => ({ ...file, sourcePath: file.path }))) {
        assertSkillSnapshotPath(mapping.path);
        assertSkillSnapshotPath(mapping.sourcePath);
        const file = byPath.get(mapping.sourcePath);
        if (!file) throw new Error("Skill version references a missing package file");
        const encoding = mapping.encoding ?? file.encoding;
        result.push({ path: mapping.path, kind: mapping.kind,
          content: (await readPackageFile(root, file, signal)).toString(encoding),
          ...(encoding === "base64" ? { encoding } : {}), ...(file.executable ? { executable: true } : {}) });
      }
      return result;
    };
    // Verify bytes as they are read, without holding the warm preparation lock.
    // A descriptor survives eviction; a missing/racing file falls back to storage.
    const root = skillPackagePaths(version.companyId, id).directory;
    const result = await withPackageIo(() => read(root).catch(() => null), signal, inventoryIo);
    if (result) {
      touchSkillPackage(root);
      return result;
    }
    signal.throwIfAborted();
    const acquire = async () => {
      const cached = await withPackageIo(() => read(root).catch(() => null), signal, inventoryIo);
      return cached ?? withIsolatedPackage(version.companyId, id, read, allowRecovery, signal, true);
    };
    return cancellation ? acquire() : flight(db, `version-read:${version.companyId}:${version.id}:${allowRecovery}`, acquire);
  }
  async function readVersionFile(version: StoredSkillVersion, relativePath: string, allowRecovery = true) {
    assertSkillSnapshotPath(relativePath);
    if (!version.packageSnapshotId) return (await versionFiles(version, allowRecovery)).find(file => file.path === relativePath);
    const id = version.packageSnapshotId;
    const manifest = await manifestFor(await descriptor(version.companyId, id));
    const mapping = version.packageFileMap?.find(file => file.path === relativePath);
    if (version.packageFileMap && !mapping) return undefined;
    const entry = manifest.files.find(file => file.path === (mapping?.sourcePath ?? relativePath));
    if (!entry) return undefined;
    const signal = AbortSignal.timeout(180_000);
    const read = async (root: string) => {
      const bytes = await readPackageFile(root, entry, signal);
      const encoding = mapping?.encoding ?? entry.encoding;
      return { path: relativePath, kind: mapping?.kind ?? entry.kind, content: bytes.toString(encoding),
        encoding, executable: entry.executable };
    };
    // Immutable cache files can be read without the preparation lock. An open
    // descriptor survives eviction; missing/racing files fall back to storage.
    const cached = await withPackageIo(() => read(skillPackagePaths(version.companyId, id).directory).catch(() => null), signal, inventoryIo);
    if (cached) return cached;
    signal.throwIfAborted();
    return flight(db, `file-read:${version.companyId}:${version.id}:${relativePath}:${allowRecovery}`,
      async () => {
        const cached = await withPackageIo(() => read(skillPackagePaths(version.companyId, id).directory).catch(() => null), signal, inventoryIo);
        return cached ?? withIsolatedPackage(version.companyId, id, read, allowRecovery, signal, true);
      });
  }
  async function versionInventory(version: StoredSkillVersion): Promise<Array<{ path: string; kind: CompanySkillVersionFileInventoryEntry["kind"] }>> {
    if (version.packageSnapshotId) {
      const index = version.packageFileMap ?? (await manifestFor(await descriptor(version.companyId, version.packageSnapshotId))).files;
      return index.map(({ path, kind }) => ({ path, kind }));
    }
    const [row] = await db.select({ ...skillVersionMetadataColumns, files: sql<Array<{ path: string; kind: CompanySkillVersionFileInventoryEntry["kind"] }>>`
      coalesce((select jsonb_agg(jsonb_build_object('path', f->>'path', 'kind', f->>'kind'))
        from jsonb_array_elements(${companySkillVersions.fileInventory}) f), '[]'::jsonb)` })
      .from(companySkillVersions).where(and(eq(companySkillVersions.companyId, version.companyId), eq(companySkillVersions.id, version.id)));
    if (row?.packageSnapshotId) return versionInventory(row);
    return row?.files ?? [];
  }
  return { descriptor, prepare, bindRestore, files, version, prefetch, versionFiles, versionInventory, readVersionFile, withPackage, withIsolatedPackage, verifyDurable,
    manifest: async (companyId: string, id: string, cancellation?: AbortSignal) => manifestFor(await descriptor(companyId, id), cancellation) };
}
