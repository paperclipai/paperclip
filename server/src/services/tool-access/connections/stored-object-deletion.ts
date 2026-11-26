import { asc, eq, lte, sql } from "drizzle-orm";
import { assets, heartbeatRuns, runnerApiResponseReservations, storedObjectDeletions, type Db } from "@paperclipai/db";
import { isRunLogStoreType, type RunLogStore } from "../../run-log-store.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import type { StorageService } from "../../../storage/types.js";

const OBJECT_BATCH_SIZE = 50;
const OBJECT_RETRY_MS = 30_000;

export async function requestIssueAttachmentObjectDeletion(tx: Db, input: { companyId: string; issueId: string }) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolConnectionContentDeletion);
  await tx.execute(sql`insert into ${storedObjectDeletions} (company_id, kind, object_key)
    select asset.company_id, 'asset', asset.object_key from ${assets} asset
      join issue_attachments link on link.asset_id = asset.id
      where link.company_id = ${input.companyId} and link.issue_id = ${input.issueId} and asset.company_id = ${input.companyId}`);
}

export async function requestCompanyStoredObjectDeletion(tx: Db, companyId: string) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolConnectionContentDeletion);
  await tx.execute(sql`insert into ${storedObjectDeletions} (company_id, kind, log_store, object_key)
    select company_id, 'run_log', log_store, log_ref from ${heartbeatRuns}
      where company_id = ${companyId} and log_ref is not null and log_store is not null
    union all
    select company_id, 'asset', null, object_key from ${assets} where company_id = ${companyId}
    union all
    select company_id, 'asset', null, pending_delete_object_key from ${runnerApiResponseReservations}
      where company_id = ${companyId} and pending_delete_object_key is not null`);
}

export function createStoredObjectDeletion(db: Db, deps: {
  runLogStore: () => RunLogStore;
  storage: () => StorageService;
  retryMs?: number;
}) {
  const retryMs = deps.retryMs ?? OBJECT_RETRY_MS;

  async function drain(signal: AbortSignal) {
    const rows = await db
      .select()
      .from(storedObjectDeletions)
      .where(lte(storedObjectDeletions.notBefore, new Date()))
      .orderBy(asc(storedObjectDeletions.notBefore), asc(storedObjectDeletions.id))
      .limit(OBJECT_BATCH_SIZE);
    let failure: unknown = null;
    for (const row of rows) {
      if (signal.aborted) break;
      try {
        if (row.kind === "run_log") {
          if (!isRunLogStoreType(row.logStore)) throw new Error("run_log_store_unrecognised");
          const store = deps.runLogStore();
          if (!store.remove) throw new Error("run_log_removal_unavailable");
          await store.remove({ store: row.logStore, logRef: row.objectKey }, signal);
        } else {
          await deps.storage().deleteObject(row.companyId, row.objectKey, { signal, allVersions: true });
        }
        await db.delete(storedObjectDeletions).where(eq(storedObjectDeletions.id, row.id));
      } catch (error) {
        failure ??= error;
        await db
          .update(storedObjectDeletions)
          .set({
            attempts: sql`${storedObjectDeletions.attempts} + 1`,
            lastError: error instanceof Error ? error.message.slice(0, 500) : "object deletion failed",
            notBefore: new Date(Date.now() + retryMs * 2 ** Math.min(row.attempts, 6)),
          })
          .where(eq(storedObjectDeletions.id, row.id));
      }
    }
    if (failure) throw failure;
  }

  async function nextDeadline() {
    const [row] = await db
      .select({ at: sql<Date | null>`min(${storedObjectDeletions.notBefore})`.mapWith(storedObjectDeletions.notBefore) })
      .from(storedObjectDeletions);
    return row?.at ? row.at.getTime() : null;
  }

  return { drain, nextDeadline };
}
