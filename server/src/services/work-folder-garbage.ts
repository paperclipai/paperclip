import { and, eq, sql } from "drizzle-orm";
import { workFolderObjects, workFiles, taskRepositoryBindings, type Db } from "@paperclipai/db";
import type { StorageProvider } from "../storage/types.js";

/** Record an upload before contacting storage, so abandoned bytes remain collectible. */
export async function registerWorkFolderObject(db: Db, storage: StorageProvider, input: {
  objectKey: string; companyId: string; folderId?: string; repositoryBindingId?: string;
}) {
  await db.insert(workFolderObjects).values({ ...input, provider: storage.id,
    deleteAfter: new Date(Date.now() + 24 * 60 * 60 * 1000) }).onConflictDoUpdate({
      target: workFolderObjects.objectKey,
      set: { deleteAfter: sql`case when ${workFolderObjects.deleteAfter} is null then null else ${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}::timestamptz end` },
    });
}

/** Bounded, retryable cleanup. Committed trash stays referenced until explicit purge. */
export async function collectWorkFolderGarbage(db: Db, storage: StorageProvider, now = new Date(), limit = 100) {
  // Polymorphic owners cannot use a single foreign key. Permanent deletion is
  // detected against the authoritative owner tables, including auth users.
  await db.execute(sql`delete from work_folders f where
    (f.scope = 'task' and not exists (select 1 from issues i where i.id::text = f.owner_id and i.company_id = f.company_id)) or
    (f.scope = 'agent' and not exists (select 1 from agents a where a.id::text = f.owner_id and a.company_id = f.company_id)) or
    (f.scope = 'project' and not exists (select 1 from projects p where p.id::text = f.owner_id and p.company_id = f.company_id)) or
    (f.scope = 'user' and not exists (select 1 from "user" u where u.id = f.owner_id))`);
  let deleted = 0;
  await db.transaction(async (tx) => {
    const candidates = await tx.select().from(workFolderObjects).where(and(eq(workFolderObjects.provider, storage.id),
      sql`(${workFolderObjects.deleteAfter} <= ${now.toISOString()}::timestamptz or (${workFolderObjects.deleteAfter} is null and (
        (${workFolderObjects.folderId} is not null and not exists (select 1 from ${workFiles} where ${workFiles.objectKey} = ${workFolderObjects.objectKey})) or
        (${workFolderObjects.repositoryBindingId} is not null and not exists (select 1 from ${taskRepositoryBindings} where ${taskRepositoryBindings.id} = ${workFolderObjects.repositoryBindingId}))
      )))`,
      sql`not exists (select 1 from ${workFiles} where ${workFiles.objectKey} = ${workFolderObjects.objectKey})`,
    )).limit(Math.max(1, Math.min(limit, 1000))).for("update", { skipLocked: true });
    for (const object of candidates) {
      const prefix = object.folderId ? `${object.companyId}/work-folders/${object.folderId}/`
        : `${object.companyId}/task-repositories/${object.repositoryBindingId}/`;
      if (!object.objectKey.startsWith(prefix)) throw new Error("Work folder garbage ownership mismatch");
      await storage.deleteObject({ objectKey: object.objectKey });
      await tx.delete(workFolderObjects).where(eq(workFolderObjects.objectKey, object.objectKey));
      deleted++;
    }
  });
  return { deleted };
}
