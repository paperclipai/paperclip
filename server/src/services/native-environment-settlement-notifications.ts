import { notifySkillVersionRetention } from "./skill-version-retention-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeEnvironmentSettlementScope = { companyId: string; runId?: string; issueId?: string };
export async function notifyNativeEnvironmentSettlement(tx: object, scope?: NativeEnvironmentSettlementScope) {
  if (scope) await notifySkillVersionRetention(tx, scope.companyId);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeEnvironmentSettlement,
    scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}
