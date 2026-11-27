import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type PluginJobDatabase = Pick<Db, "transaction" | "select" | "update" | "insert" | "delete">;

export function writePluginJobChange<T>(db: PluginJobDatabase, write: (tx: PluginJobDatabase) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.pluginSchedules);
    return write(tx);
  });
}
