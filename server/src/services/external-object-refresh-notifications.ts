import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyExternalObjectRefresh(tx: object, companyId?: string, objectId?: string) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.externalObjectRefresh,
    companyId ? JSON.stringify({ companyId, ...(objectId ? { objectId } : {}) }) : "*");
}

