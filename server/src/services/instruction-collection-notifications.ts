import { notifySkillVersionRetention } from "./skill-version-retention-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type InstructionCollectionScope = { companyId: string; runId?: string };

export async function notifyInstructionCollection(transaction: object, scope?: InstructionCollectionScope) {
  if (scope) await notifySkillVersionRetention(transaction, scope.companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.instructionCollection, scope ? JSON.stringify(scope) : "*");
}
