import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, asc, eq, gt, isNull, isNotNull, max, sql } from "drizzle-orm";
import { workFolders, workFiles, workFileOperations, workFolderObjects, type Db } from "@paperclipai/db";
import { validateWorkFilePath, type WorkFile, type WorkFolderOwner } from "@paperclipai/shared";
import { registerWorkFolderObject } from "./work-folder-garbage.js";
import type { StorageProvider } from "../storage/types.js";
import { badRequest, conflict, notFound, payloadTooLarge } from "../errors.js";

export const MAX_WORK_FILE_BYTES = 1024 * 1024 * 1024;
type Folder = typeof workFolders.$inferSelect;
type FileRow = typeof workFiles.$inferSelect;

export function workFileDto(row: FileRow): WorkFile {
  return { id: row.id, path: row.path, kind: row.kind, byteSize: row.byteSize,
    sha256: row.sha256, executable: row.executable, contentType: row.contentType,
    deletedAt: row.deletedAt?.toISOString() ?? null, updatedAt: row.updatedAt.toISOString() };
}

function validPath(value: string) {
  try { return validateWorkFilePath(value); } catch { throw badRequest("Invalid work file path"); }
}

/** The caller must authorize the folder owner before using this host-only service. */
export function workFolderService(db: Db, storage: StorageProvider) {
  async function ensure(owner: WorkFolderOwner): Promise<Folder> {
    await db.insert(workFolders).values(owner).onConflictDoNothing();
    const [folder] = await db.select().from(workFolders).where(and(eq(workFolders.companyId, owner.companyId),
      eq(workFolders.scope, owner.scope), eq(workFolders.ownerId, owner.ownerId)));
    if (!folder) throw notFound("Work folder not found");
    return folder;
  }

  async function list(folder: Folder, options: { trash?: boolean; cursor?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(1000, options.limit ?? 200));
    const rows = await db.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
      eq(workFiles.companyId, folder.companyId), options.trash ? isNotNull(workFiles.deletedAt) : isNull(workFiles.deletedAt),
      options.cursor ? gt(workFiles.id, options.cursor) : undefined)).orderBy(asc(workFiles.id)).limit(limit + 1);
    const [saved] = await db.select({ at: max(workFileOperations.createdAt) }).from(workFileOperations)
      .where(and(eq(workFileOperations.companyId, folder.companyId), eq(workFileOperations.folderId, folder.id)));
    return { id: folder.id, owner: { companyId: folder.companyId, scope: folder.scope, ownerId: folder.ownerId },
      lastOperationAt: saved?.at?.toISOString() ?? null,
      files: rows.slice(0, limit).map(workFileDto), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null };
  }

  async function get(folder: Folder, filePath: string) {
    const [row] = await db.select().from(workFiles).where(and(eq(workFiles.companyId, folder.companyId),
      eq(workFiles.folderId, folder.id), eq(workFiles.path, validPath(filePath)), isNull(workFiles.deletedAt)));
    if (!row) throw notFound("Work file not found");
    return row;
  }

  async function content(folder: Folder, filePath: string) {
    const row = await get(folder, filePath);
    if (row.kind !== "file" || !row.objectKey) throw badRequest("Path is a directory");
    return { file: workFileDto(row), ...(await storage.getObject({ objectKey: row.objectKey })) };
  }

  async function mutate<T>(folder: Folder, operationId: string, fingerprint: string,
    apply: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) {
    if (!operationId || operationId.length > 256) throw badRequest("An operation ID is required");
    return db.transaction(async (tx) => {
      // Serialize acceptance order across all app processes, including mkdir/delete races.
      const [locked] = await tx.select().from(workFolders).where(and(eq(workFolders.id, folder.id),
        eq(workFolders.companyId, folder.companyId))).for("update");
      if (!locked) throw notFound("Work folder not found");
      const [receipt] = await tx.select().from(workFileOperations).where(and(
        eq(workFileOperations.folderId, folder.id), eq(workFileOperations.operationId, operationId)));
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw conflict("Operation ID was already used for different content");
        return { applied: false as const };
      }
      const result = await apply(tx);
      await tx.insert(workFileOperations).values({ companyId: folder.companyId, folderId: folder.id, operationId, fingerprint });
      return { applied: true as const, result };
    });
  }

  async function write(folder: Folder, input: {
    path: string; body?: Readable | Buffer; contentType?: string; executable?: boolean;
    kind?: "file" | "directory"; operationId: string; maxBytes?: number; expectedSha256?: string | null;
    replaceKind?: boolean; onlyIfMissing?: boolean;
  }) {
    const filePath = validPath(input.path);
    const kind = input.kind ?? "file";
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-work-file-"));
    const spool = path.join(directory, "content");
    const hash = createHash("sha256");
    let byteSize = 0;
    let objectKey: string | null = null;
    let discardUpload = false;
    try {
      if (kind === "file") {
        const source = Buffer.isBuffer(input.body) ? Readable.from([input.body]) : input.body ?? Readable.from([]);
        await pipeline(source, new Transform({ transform(chunk: Buffer, _encoding, callback) {
          byteSize += chunk.length;
          if (byteSize > (input.maxBytes ?? MAX_WORK_FILE_BYTES)) return callback(payloadTooLarge("Work file exceeds the size limit"));
          hash.update(chunk);
          callback(null, chunk);
        } }), createWriteStream(spool, { mode: 0o600 }));
        objectKey = `${folder.companyId}/work-folders/${folder.id}/${randomUUID()}`;
        await registerWorkFolderObject(db, storage, { objectKey, companyId: folder.companyId, folderId: folder.id });
        await storage.putObject({ objectKey, body: createReadStream(spool), contentLength: byteSize,
          contentType: input.contentType ?? "application/octet-stream" });
      }
      const sha256 = kind === "file" ? hash.digest("hex") : null;
      if (input.expectedSha256 && input.expectedSha256 !== sha256) throw conflict("File changed during transfer; retry the checkpoint");
      const value = { kind, objectKey, byteSize, sha256, executable: input.executable ?? false,
        contentType: input.contentType ?? "application/octet-stream", updatedAt: new Date() };
      const fingerprint = JSON.stringify(["write", filePath, kind, sha256, value.executable, value.contentType, Boolean(input.replaceKind), Boolean(input.onlyIfMissing)]);
      const result = await mutate(folder, input.operationId, fingerprint, async (tx) => {
        const parts = filePath.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          const [existing] = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
            eq(workFiles.path, parent), isNull(workFiles.deletedAt)));
          if (existing && existing.kind !== "directory") throw conflict("A parent path is a file");
          if (!existing) await tx.insert(workFiles).values({ companyId: folder.companyId, folderId: folder.id,
            path: parent, kind: "directory" });
        }
        const previousRows = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
          eq(workFiles.path, filePath), isNull(workFiles.deletedAt)));
        let previous: FileRow | undefined = previousRows[0];
        if (previous && input.onlyIfMissing) return { oldKey: null, unusedUpload: true };
        if (previous && previous.kind !== kind) {
          if (!input.replaceKind) throw conflict("Delete the existing path before changing its kind");
          const prefix = `${filePath}/`;
          await tx.update(workFiles).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(
            eq(workFiles.folderId, folder.id), isNull(workFiles.deletedAt),
            sql`(${workFiles.path} = ${filePath} or left(${workFiles.path}, ${prefix.length}) = ${prefix})`));
          previous = undefined;
        }
        if (previous) {
          await tx.update(workFiles).set(value).where(eq(workFiles.id, previous.id));
        } else {
          await tx.insert(workFiles).values({ ...value, companyId: folder.companyId, folderId: folder.id, path: filePath });
        }
        if (objectKey) await tx.update(workFolderObjects).set({ deleteAfter: null }).where(eq(workFolderObjects.objectKey, objectKey));
        if (previous?.objectKey) await tx.update(workFolderObjects).set({ deleteAfter: new Date() }).where(eq(workFolderObjects.objectKey, previous.objectKey));
        return { oldKey: previous?.objectKey ?? null, unusedUpload: false };
      });
      discardUpload = !result.applied || result.result.unusedUpload;
      // Object keys are private to this service; receipts contain no overwritten content.
      // Cleanup is journaled in the same transaction as replacement. Storage
      // outages and lost commit replies cannot orphan the only current object.
      return { applied: result.applied };
    } finally {
      // A lost database response can mean COMMIT succeeded. Retain an uncertain
      // upload for reconciliation; deleting it here could destroy saved content.
      if (objectKey && discardUpload) await db.update(workFolderObjects).set({ deleteAfter: new Date() }).where(eq(workFolderObjects.objectKey, objectKey));
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function remove(folder: Folder, filePath: string, operationId: string) {
    const normalized = validPath(filePath);
    return mutate(folder, operationId, JSON.stringify(["delete", normalized]), async (tx) => {
      const prefix = `${normalized}/`;
      await tx.update(workFiles).set({ deletedAt: new Date(), updatedAt: new Date() }).where(and(
        eq(workFiles.folderId, folder.id), isNull(workFiles.deletedAt),
        sql`(${workFiles.path} = ${normalized} or left(${workFiles.path}, ${prefix.length}) = ${prefix})`));
    });
  }

  async function restore(folder: Folder, fileId: string, operationId: string) {
    return mutate(folder, operationId, JSON.stringify(["restore", fileId]), async (tx) => {
      const [deleted] = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
        eq(workFiles.id, fileId), isNotNull(workFiles.deletedAt)));
      if (!deleted) throw notFound("Deleted file not found");
      const prefix = `${deleted.path}/`;
      const restoreRows = deleted.kind === "directory" ? await tx.select().from(workFiles).where(and(
        eq(workFiles.folderId, folder.id), eq(workFiles.deletedAt, deleted.deletedAt!),
        sql`(${workFiles.path} = ${deleted.path} or left(${workFiles.path}, ${prefix.length}) = ${prefix})`)) : [deleted];
      for (const row of restoreRows) {
        const [occupied] = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
          eq(workFiles.path, row.path), isNull(workFiles.deletedAt)));
        if (occupied) throw conflict("Delete the current file before restoring this deleted copy");
      }
      const parts = deleted.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        const [existing] = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
          eq(workFiles.path, parent), isNull(workFiles.deletedAt)));
        if (existing && existing.kind !== "directory") throw conflict("A parent path is a file");
        if (!existing) await tx.insert(workFiles).values({ companyId: folder.companyId, folderId: folder.id,
          path: parent, kind: "directory" });
      }
      for (const row of restoreRows) await tx.update(workFiles).set({ deletedAt: null, updatedAt: new Date() }).where(eq(workFiles.id, row.id));
    });
  }

  async function purge(folder: Folder, fileId: string, operationId: string) {
    return mutate(folder, operationId, JSON.stringify(["purge", fileId]), async (tx) => {
      const [deleted] = await tx.select().from(workFiles).where(and(eq(workFiles.folderId, folder.id),
        eq(workFiles.id, fileId), isNotNull(workFiles.deletedAt)));
      if (!deleted) throw notFound("Deleted file not found");
      const prefix = `${deleted.path}/`;
      const rows = await tx.delete(workFiles).where(and(eq(workFiles.folderId, folder.id),
        eq(workFiles.deletedAt, deleted.deletedAt!), deleted.kind === "directory"
          ? sql`(${workFiles.path} = ${deleted.path} or left(${workFiles.path}, ${prefix.length}) = ${prefix})`
          : eq(workFiles.id, fileId))).returning({ objectKey: workFiles.objectKey });
      for (const row of rows) if (row.objectKey) await tx.update(workFolderObjects).set({ deleteAfter: new Date() }).where(eq(workFolderObjects.objectKey, row.objectKey));
    });
  }
  return { ensure, list, get, content, write, remove, restore, purge };
}
