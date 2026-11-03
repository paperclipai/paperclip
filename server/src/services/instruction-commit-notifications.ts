import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type InstructionCommitScope = { companyId: string; runId?: string };

export async function notifyInstructionCommit(transaction: object, scope?: InstructionCommitScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.instructionCommit, scope ? JSON.stringify(scope) : "*");
}
