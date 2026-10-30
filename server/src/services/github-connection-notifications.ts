import type { toolConnections } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
export async function notifyGitHubCredentialChange(transaction: object, connection: Pick<typeof toolConnections.$inferSelect, "config">) {
  if (connection.config.sourceTemplateKey !== "github") return;
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionContinuity);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.connectionEvents);
}
