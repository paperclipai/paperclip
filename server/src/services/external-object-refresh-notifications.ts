import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ExternalObjectRefreshIdentity = { providerKey: string; objectType: string; externalId: string; ignoreExternalIdCase?: boolean };

export async function notifyExternalObjectRefresh(tx: object, companyId?: string, object?: string | ExternalObjectRefreshIdentity) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.externalObjectRefresh,
    companyId ? JSON.stringify({ companyId, ...(typeof object === "string" ? { objectId: object } : object ? { identity: object } : {}) }) : "*");
}
