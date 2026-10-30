import path from "node:path";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { companySkillRepositorySnapshots as snapshots, companySkillVersions as versions,
  skillPackageDeletions, type Db } from "@paperclipai/db";
import { getStorageService, type StorageService } from "../storage/index.js";
import { skillPackageStore, skillVersionFileMap, skillVersionMetadataColumns } from "./skill-package-store.js";
import { packageSha256 } from "./skill-package-files.js";
import { skillFileBytes, skillSnapshotHash } from "./skill-snapshot.js";

type PageOptions = { id?: string; signal?: AbortSignal; companyId?: string; after?: string; limit?: number; apply?: boolean; clearLegacy?: boolean };
const pageSize = (options: PageOptions) => Math.min(50, Math.max(1, options.limit ?? 10));

/** Bounded maintenance shared by automatic delivery and optional operator diagnostics. */
export function skillPackageMaintenance(db: Db, storage?: StorageService) {
  const store = skillPackageStore(db, storage);
  async function migrateSnapshots(options: PageOptions = {}) {
    const rows = await db.select({ id: snapshots.id, companyId: snapshots.companyId, contentHash: snapshots.contentHash })
      .from(snapshots).where(and(options.companyId ? eq(snapshots.companyId, options.companyId) : undefined,
        options.id ? eq(snapshots.id, options.id) : undefined,
        options.after ? gt(snapshots.id, options.after) : undefined, options.clearLegacy ? undefined : isNull(snapshots.storage)))
      .orderBy(asc(snapshots.id)).limit(pageSize(options));
    let migrated = 0;
    if (options.apply) for (const row of rows) {
      // Transfer only one legacy body at a time. Never trust a mutable upstream.
      const [legacy] = await db.select({ files: snapshots.fileInventory }).from(snapshots).where(eq(snapshots.id, row.id));
      options.signal?.throwIfAborted();
      if (!legacy?.files.length) {
        await db.update(snapshots).set({ migrationAt: null }).where(eq(snapshots.id, row.id));
        continue;
      }
      if (skillSnapshotHash(legacy.files) !== row.contentHash) throw new Error(`Legacy package hash mismatch: ${row.id}`);
      const id = await store.prepare(row.companyId, legacy.files, true, options.signal);
      if (id !== row.id || !await store.verifyDurable(row.companyId, id, options.signal)) throw new Error(`Package verification failed: ${row.id}`);
      // An ambiguous result is safe to retry: storage is already published, IDs
      // are unchanged, and the old bytes survive until this final update.
      if (options.clearLegacy) await db.update(snapshots).set({ fileInventory: [], migrationAt: null }).where(and(eq(snapshots.id, id), eq(snapshots.contentHash, row.contentHash), sql`${snapshots.storage} is not null`));
      migrated++;
    }
    return { inspected: rows.length, migrated, after: rows.at(-1)?.id ?? null };
  }

  async function migrateVersions(options: PageOptions = {}) {
    const rows = await db.select(skillVersionMetadataColumns).from(versions).where(and(
      options.companyId ? eq(versions.companyId, options.companyId) : undefined,
      options.id ? eq(versions.id, options.id) : undefined,
      options.after ? gt(versions.id, options.after) : undefined, options.clearLegacy ? undefined : isNull(versions.packageSnapshotId), isNull(versions.releaseId)))
      .orderBy(asc(versions.id)).limit(pageSize(options));
    let migrated = 0;
    if (options.apply) for (const row of rows) {
      const [legacy] = await db.select({ files: versions.fileInventory }).from(versions).where(eq(versions.id, row.id));
      const files = legacy?.files;
      options.signal?.throwIfAborted();
      if (!files?.length) {
        await db.update(versions).set({ migrationAt: null }).where(eq(versions.id, row.id));
        continue;
      }
      if (row.repositorySnapshotId) await migrateSnapshots({ id: row.repositorySnapshotId, apply: true, clearLegacy: true, signal: options.signal });
      let packageId = row.packageSnapshotId;
      let fileMap = row.packageFileMap;
      if (packageId && skillSnapshotHash(await store.versionFiles(row, true, options.signal)) !== skillSnapshotHash(files)) throw new Error(`Legacy version differs from its package: ${row.id}`);
      if (!packageId && row.repositorySnapshotId && row.repositorySkillPath) {
        const manifest = await store.manifest(row.companyId, row.repositorySnapshotId, options.signal);
        const byPath = new Map(manifest.files.map(file => [file.path, file]));
        const mappings = files.map(file => ({ path: file.path, kind: file.kind, encoding: file.encoding ?? "utf8" as const,
          sourcePath: file.path === "SKILL.md" ? row.repositorySkillPath! : path.posix.join(path.posix.dirname(row.repositorySkillPath!), file.path) }));
        if (files.every((file, index) => {
          const source = byPath.get(mappings[index]!.sourcePath);
          return source?.sha256 === packageSha256(skillFileBytes(file)) && source.executable === Boolean(file.executable);
        })) { packageId = row.repositorySnapshotId; fileMap = mappings; }
      }
      packageId ??= await store.prepare(row.companyId, files, true, options.signal);
      const legacyMetadata = new Map(files.map(file => [file.path, file]));
      fileMap = fileMap ? fileMap.map(file => ({ ...file, kind: legacyMetadata.get(file.path)?.kind ?? file.kind,
        encoding: legacyMetadata.get(file.path)?.encoding ?? "utf8" })) : skillVersionFileMap(files, await store.manifest(row.companyId, packageId, options.signal));
      const receipt = await store.descriptor(row.companyId, packageId);
      if (!receipt.storage || !await store.verifyDurable(row.companyId, packageId, options.signal)) throw new Error(`Package must be migrated and verified first: ${packageId}`);
      await db.update(versions).set({ packageSnapshotId: packageId, packageFileMap: fileMap, ...(options.clearLegacy ? { fileInventory: [], migrationAt: null } : {}) })
        .where(and(eq(versions.companyId, row.companyId), eq(versions.id, row.id), row.packageSnapshotId ? eq(versions.packageSnapshotId, row.packageSnapshotId) : isNull(versions.packageSnapshotId)));
      migrated++;
    }
    return { inspected: rows.length, migrated, after: rows.at(-1)?.id ?? null };
  }

  async function collectOrphans(options: PageOptions = {}) {
    const unused = sql`not exists (select 1 from ${versions} where ${versions.repositorySnapshotId} = ${snapshots.id} or ${versions.packageSnapshotId} = ${snapshots.id})`;
    const expired = sql`(${snapshots.upload} is null or (${snapshots.upload}->>'expiresAt')::timestamptz < now())`;
    const rows = await db.select({ id: snapshots.id }).from(snapshots).where(and(
      options.companyId ? eq(snapshots.companyId, options.companyId) : undefined,
      options.id ? eq(snapshots.id, options.id) : undefined,
        options.after ? gt(snapshots.id, options.after) : undefined,
      sql`${snapshots.createdAt} < now() - interval '1 day'`,
      expired, unused,
    )).orderBy(asc(snapshots.id)).limit(pageSize(options));
    let removed = 0;
    if (options.apply) for (const row of rows) {
      // FK locking wins against a concurrent publication. The trigger persists
      // deletion receipts in the same transaction, including company cascades.
      const deleted = await db.delete(snapshots).where(and(eq(snapshots.id, row.id), expired, unused)).returning({ id: snapshots.id });
      removed += deleted.length;
    }
    return { inspected: rows.length, removed, after: rows.at(-1)?.id ?? null };
  }

  async function deleteObjects(options: PageOptions = {}) {
    const backend = storage ?? getStorageService();
    const rows = await db.select().from(skillPackageDeletions).where(and(
      options.companyId ? eq(skillPackageDeletions.companyId, options.companyId) : undefined,
      options.id ? eq(skillPackageDeletions.id, options.id) : undefined,
      options.after ? gt(skillPackageDeletions.id, options.after) : undefined,
      lte(skillPackageDeletions.deleteAfter, new Date()), eq(skillPackageDeletions.provider, backend.provider),
    )).orderBy(asc(skillPackageDeletions.id)).limit(pageSize(options));
    let removed = 0;
    if (options.apply) for (const row of rows) {
      options.signal?.throwIfAborted();
      const [referenced] = await db.select({ id: snapshots.id }).from(snapshots).where(and(eq(snapshots.companyId, row.companyId),
        sql`(${snapshots.storage}->>'archiveKey' = ${row.archiveKey} or ${snapshots.upload}->>'archiveKey' = ${row.archiveKey})`)).limit(1);
      if (referenced) {
        // Live ownership supersedes this receipt. A future replacement/deletion
        // enqueues fresh work in the same transaction as the ownership change.
        await db.delete(skillPackageDeletions).where(eq(skillPackageDeletions.id, row.id));
        continue;
      }
      const timeout = AbortSignal.timeout(30_000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      for (const key of [row.archiveKey, row.manifestKey]) {
        await backend.deleteObject(row.companyId, key, { signal });
        if ((await backend.headObject(row.companyId, key, { signal })).exists) throw new Error(`Storage did not confirm package deletion: ${row.id}`);
      }
      signal.throwIfAborted();
      await db.delete(skillPackageDeletions).where(eq(skillPackageDeletions.id, row.id));
      removed++;
    }
    return { inspected: rows.length, removed, after: rows.at(-1)?.id ?? null };
  }
  return { migrateSnapshots, migrateVersions, collectOrphans, deleteObjects };
}
