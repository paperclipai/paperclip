import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { companySkillRepositorySnapshots as snapshots, type Db, type SkillPackageStorageReceipt } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import { boundedHashStream } from "./skill-package-files.js";
import { skillPackageStore } from "./skill-package-store.js";

export async function migrateLocalSkillPackageObjects(db: Db, input: {
  source: StorageService; destination: StorageService; writersStopped: boolean; signal: AbortSignal; after?: string;
}) {
  if (!input.writersStopped || process.env.PAPERCLIP_EPHEMERAL_MIGRATION !== "true"
    || input.source.provider !== "local_disk" || input.destination.provider !== "s3") throw new Error("offline_skill_object_migration_required");
  const rows = await db.select({ id: snapshots.id, companyId: snapshots.companyId, storage: snapshots.storage })
    .from(snapshots).where(and(sql`${snapshots.storage}->>'provider' = 'local_disk'`,
      input.after ? gt(snapshots.id, input.after) : undefined)).orderBy(asc(snapshots.id)).limit(50);
  const source = skillPackageStore(db, input.source);
  for (const row of rows) {
    input.signal.throwIfAborted();
    const original = row.storage!;
    if (!await source.verifyDurable(row.companyId, row.id, input.signal)) throw new Error("local_skill_object_verification_failed");
    const token = randomUUID(), prefix = `${row.companyId}/skill-packages/${token}`;
    const upload = { token, legacy: true, provider: "s3" as const, archiveKey: `${prefix}/files.tar.gz`,
      manifestKey: `${prefix}/manifest.json`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const unchanged = sql`${snapshots.storage} = ${JSON.stringify(original)}::jsonb`;
    const [claimed] = await db.update(snapshots).set({ upload }).where(and(eq(snapshots.companyId, row.companyId), eq(snapshots.id, row.id), unchanged,
      sql`(${snapshots.upload} is null or (${snapshots.upload}->>'expiresAt')::timestamptz <= now())`)).returning({ id: snapshots.id });
    if (!claimed) throw new Error("skill_object_migration_owner_busy");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-object-migration-"));
    try {
      for (const object of [
        { source: original.archiveKey, target: upload.archiveKey, bytes: original.archiveBytes, sha256: original.archiveSha256,
          filename: "files.tar.gz", contentType: "application/gzip" },
        { source: original.manifestKey, target: upload.manifestKey, bytes: original.manifestBytes, sha256: original.manifestSha256,
          filename: "manifest.json", contentType: "application/json" },
      ]) {
        const filename = path.join(directory, object.filename);
        const read = await input.source.getObject(row.companyId, object.source, { signal: input.signal });
        const originalDigest = boundedHashStream(object.bytes);
        await pipeline(read.stream, originalDigest.stream, createWriteStream(filename, { flags: "wx", mode: 0o600 }), { signal: input.signal });
        const actual = originalDigest.result();
        if (actual.bytes !== object.bytes || actual.sha256 !== object.sha256) throw new Error("local_skill_object_changed");
        await input.destination.putFile({ companyId: row.companyId, namespace: "skill-packages", objectKey: object.target,
          originalFilename: object.filename, contentType: object.contentType, body: createReadStream(filename),
          byteSize: object.bytes, sha256: object.sha256, signal: input.signal });
        const saved = await input.destination.getObject(row.companyId, object.target, { signal: input.signal });
        const remoteDigest = boundedHashStream(object.bytes);
        await pipeline(saved.stream, remoteDigest.stream, new Writable({ write(_chunk, _encoding, done) { done(); } }), { signal: input.signal });
        const verified = remoteDigest.result();
        if (verified.bytes !== object.bytes || verified.sha256 !== object.sha256) throw new Error("remote_skill_object_verification_failed");
      }
      input.signal.throwIfAborted();
      const receipt: SkillPackageStorageReceipt = { ...original, provider: "s3", archiveKey: upload.archiveKey, manifestKey: upload.manifestKey };
      const [published] = await db.update(snapshots).set({ storage: receipt, upload: null, migrationAt: null })
        .where(and(eq(snapshots.companyId, row.companyId), eq(snapshots.id, row.id), unchanged,
          sql`${snapshots.upload}->>'token' = ${token}`)).returning({ id: snapshots.id });
      if (!published) throw new Error("skill_object_migration_owner_changed");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  return { inspected: rows.length, migrated: rows.length, after: rows.at(-1)?.id ?? null };
}
