import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { chatTeamsFileTransfers, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";

export const unusedTeamsConsentPhases = ["consent_pending", "awaiting_consent", "upload_pending"];
type Entry = { id: string; companyId: string; dueAt: number };

export function notifyTeamsConsentExpiry(tx: object, id: string) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatTeamsConsentExpiry, id);
}

/** Owns only unused consent deadlines, not transport attempts or unknown outcomes. */
export function teamsConsentExpiryWork(db: Db, expire: (companyId: string, id: string) => Promise<boolean>) {
  const cursors = new Map<string, string>();
  async function page(id?: string, cursor?: string, signal?: AbortSignal): Promise<Entry[]> {
    try {
      signal?.throwIfAborted();
      const rows = await db.select({ id: chatTeamsFileTransfers.id, companyId: chatTeamsFileTransfers.companyId,
        dueAt: sql<string>`ceil(extract(epoch from ${chatTeamsFileTransfers.expiresAt}) * 1000)`,
      }).from(chatTeamsFileTransfers).where(and(inArray(chatTeamsFileTransfers.phase, unusedTeamsConsentPhases),
        id ? eq(chatTeamsFileTransfers.id, id) : undefined,
        cursor ? gt(chatTeamsFileTransfers.id, cursor) : undefined)).orderBy(chatTeamsFileTransfers.id).limit(100);
      signal?.throwIfAborted();
      return rows.map(row => ({ ...row, dueAt: Number(row.dueAt) }));
    } catch {
      throw new Error("Teams consent expiry selection is temporarily unavailable");
    }
  }
  async function load(id?: string, signal?: AbortSignal): Promise<Entry[]> {
    const entries: Entry[] = []; let cursor: string | undefined;
    for (;;) {
      const rows = await page(id, cursor, signal);
      entries.push(...rows);
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].id;
    }
  }
  async function refresh(id?: string, signal?: AbortSignal) {
    const key = id ?? "*", rows = await page(id, cursors.get(key), signal), complete = rows.length < 100;
    if (complete) cursors.delete(key); else cursors.set(key, rows[rows.length - 1].id);
    return { rows, complete };
  }
  async function check(entry: Entry, signal?: AbortSignal): Promise<Entry | null> {
    const current = (await load(entry.id, signal))[0];
    if (!current) return null;
    if (current.dueAt > Date.now()) return current;
    signal?.throwIfAborted();
    try { await expire(current.companyId, current.id); }
    catch { throw new Error("Teams consent expiry could not settle"); }
    return (await load(entry.id, signal))[0] ?? null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    cursors.clear();
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatTeamsConsentExpiry,
      decodeScope: (hint: string) => hint === "*" ? undefined : hint,
      matches: (entry: Entry, id?: string) => !id || entry.id === id,
      load: refresh, check,
    }, canRun);
  }
  return { load, check, register };
}
