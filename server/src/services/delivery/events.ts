import { and, desc, eq } from "drizzle-orm";
import { deliveryEvents, type Db } from "@paperclipai/db";
import type { DeliveryEvent } from "@paperclipai/shared";

export type DeliveryEventRow = typeof deliveryEvents.$inferSelect;

export interface DeliveryEventService {
  append(input: {
    companyId: string;
    unitId: string;
    issueId?: string | null;
    type: string;
    message: string;
    dedupeKey?: string | null;
    url?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<{ id: string; created: boolean }>;
  list(companyId: string, unitId: string, limit?: number): Promise<DeliveryEvent[]>;
  listForIssue(companyId: string, issueId: string, limit?: number): Promise<DeliveryEvent[]>;
}

/**
 * Deduplicated delivery timeline. A repeated actionable event carries the same
 * `dedupeKey`, so replaying a reconciliation never duplicates a wake or a
 * finding record.
 */
export function deliveryEventService(db: Db): DeliveryEventService {
  async function append(input: {
    companyId: string;
    unitId: string;
    issueId?: string | null;
    type: string;
    message: string;
    dedupeKey?: string | null;
    url?: string | null;
    payload?: Record<string, unknown>;
  }) {
    const [inserted] = await db
      .insert(deliveryEvents)
      .values({
        companyId: input.companyId,
        unitId: input.unitId,
        issueId: input.issueId ?? null,
        type: input.type,
        message: input.message,
        dedupeKey: input.dedupeKey ?? null,
        url: input.url ?? null,
        payload: input.payload ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: deliveryEvents.id });
    return inserted ? { id: inserted.id, created: true } : { id: "", created: false };
  }

  function toEvent(row: DeliveryEventRow): DeliveryEvent {
    return {
      id: row.id,
      type: row.type,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      url: row.url,
    };
  }

  async function list(companyId: string, unitId: string, limit = 20) {
    const rows = await db
      .select()
      .from(deliveryEvents)
      .where(and(eq(deliveryEvents.companyId, companyId), eq(deliveryEvents.unitId, unitId)))
      .orderBy(desc(deliveryEvents.createdAt))
      .limit(limit);
    return rows.reverse().map(toEvent);
  }

  async function listForIssue(companyId: string, issueId: string, limit = 20) {
    const rows = await db
      .select()
      .from(deliveryEvents)
      .where(and(eq(deliveryEvents.companyId, companyId), eq(deliveryEvents.issueId, issueId)))
      .orderBy(desc(deliveryEvents.createdAt))
      .limit(limit);
    return rows.reverse().map(toEvent);
  }

  return { append, list, listForIssue };
}
