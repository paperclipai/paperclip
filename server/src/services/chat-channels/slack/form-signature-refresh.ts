import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { SlackCloudReceiptError } from "./cloud-event.js";

type Row = typeof chatActions.$inferSelect;
export async function replaceSlackFormReceiptSignature(db: Db, row: Row, field: "retirementReceiptJws" | "formAck", compactJws: string): Promise<Row> {
  const old = field === "retirementReceiptJws" ? row.result?.retirementReceiptJws
    : row.result?.formAck && typeof row.result.formAck === "object" ? Reflect.get(row.result.formAck, "receiptJws") : undefined;
  if (typeof old !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(compactJws) || Buffer.byteLength(compactJws, "ascii") > 12000)
    throw new SlackCloudReceiptError("form_signature_refresh_invalid", "attention");
  if (old === compactJws) return row;
  return db.transaction(async tx => {
    const [current] = await tx.select().from(chatActions).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId), eq(chatActions.endpointId, row.endpointId))).for("update");
    if (!current || current.status !== row.status || current.kind !== row.kind || current.providerActionId !== row.providerActionId
      || !isDeepStrictEqual(current.payload, row.payload) || !isDeepStrictEqual(current.result, row.result))
      throw new SlackCloudReceiptError("form_signature_refresh_changed", "retry");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.connectionEvents);
    const result = field === "retirementReceiptJws"
      ? sql`jsonb_set(${chatActions.result}, '{retirementReceiptJws}', ${JSON.stringify(compactJws)}::jsonb, false)`
      : sql`jsonb_set(${chatActions.result}, '{formAck,receiptJws}', ${JSON.stringify(compactJws)}::jsonb, false)`;
    const [updated] = await tx.update(chatActions).set({ result, updatedAt: new Date() }).where(and(eq(chatActions.id, row.id), eq(chatActions.companyId, row.companyId),
      eq(chatActions.endpointId, row.endpointId), eq(chatActions.status, row.status), eq(chatActions.kind, row.kind), eq(chatActions.providerActionId, row.providerActionId),
      sql`${chatActions.payload} = ${JSON.stringify(row.payload)}::jsonb`, sql`${chatActions.result} = ${JSON.stringify(row.result)}::jsonb`)).returning();
    if (!updated) throw new SlackCloudReceiptError("form_signature_refresh_changed", "retry");
    return updated;
  });
}
