import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { chatTeamsFileTransfers, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";

export const abandonedTeamsAttemptPhases = ["consent_sending", "uploading", "file_info_sending", "conflict"];
type Entry = { id: string; companyId: string; dueAt: number };

export function notifyTeamsAttemptRecovery(tx: object, id: string) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatTeamsAttemptRecovery, id);
}

/** Retires expired transport claims without retrying an unknown provider effect. */
export function teamsAttemptRecoveryWork(db: Db, recover: (companyId: string, id: string) => Promise<boolean>) {
  async function load(id?: string, signal?: AbortSignal): Promise<Entry[]> {
    try {
      const entries: Entry[] = []; let cursor: string | undefined;
      for (;;) {
        signal?.throwIfAborted();
        const rows = await db.select({ id: chatTeamsFileTransfers.id, companyId: chatTeamsFileTransfers.companyId,
          dueAt: sql<string>`ceil(extract(epoch from ${chatTeamsFileTransfers.attemptExpiresAt}) * 1000)`,
        }).from(chatTeamsFileTransfers).where(and(inArray(chatTeamsFileTransfers.phase, abandonedTeamsAttemptPhases),
          isNotNull(chatTeamsFileTransfers.attemptExpiresAt),
          id ? eq(chatTeamsFileTransfers.id, id) : undefined,
          cursor ? gt(chatTeamsFileTransfers.id, cursor) : undefined)).orderBy(chatTeamsFileTransfers.id).limit(100);
        entries.push(...rows.map(row => ({ ...row, dueAt: Number(row.dueAt) })));
        if (rows.length < 100) return entries;
        cursor = rows[rows.length - 1].id;
      }
    } catch {
      // Never expose private transfer envelopes or SQL parameter errors.
      throw new Error("Teams attempt recovery selection is temporarily unavailable");
    }
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const current = (await load(entry.id, signal))[0];
    if (!current) return null;
    if (current.dueAt > Date.now()) return current;
    signal?.throwIfAborted();
    try { await recover(current.companyId, current.id); }
    catch { throw new Error("Teams attempt recovery could not settle"); }
    return (await load(entry.id, signal))[0] ?? null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatTeamsAttemptRecovery,
      decodeScope: (hint: string) => hint === "*" ? undefined : hint,
      matches: (entry: Entry, id?: string) => !id || entry.id === id,
      load, check,
    }, canRun);
  }
  return { load, check, register };
}
