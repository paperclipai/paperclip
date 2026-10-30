import { toolConnections, chatEndpoints, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
export async function notifyGitHubCredentialChange(transaction: object, connection: Pick<typeof toolConnections.$inferSelect, "config" | "companyId">) {
  if (connection.config.sourceTemplateKey !== "github") return;
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionContinuity, connection.companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionEvents, connection.companyId);
}

/** Company lifecycle changes only activate owners with a supported registration. */
export async function notifyGitHubCompanyChange(transaction: object, companyId: string) {
  const db = transaction as Db;
  const [connection] = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), sql`${toolConnections.config}->>'sourceTemplateKey' = 'github'`,
  )).limit(1);
  if (connection) {
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionContinuity, companyId);
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionEvents, companyId);
    return;
  }
  const [bot] = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
    eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.provider, "github"),
    sql`${chatEndpoints.setup}->'github'->>'cloudRegistrationId' is not null`,
  )).limit(1);
  if (bot) await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionEvents, companyId);
}
