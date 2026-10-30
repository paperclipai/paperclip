import { signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";

/** Topics for existing durable queues; register intent before their writes. */
export const DELIVERY_QUEUES = {
  statusCardEvaluation: "status-card-evaluation",
