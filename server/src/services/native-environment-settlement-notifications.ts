import { notifyNativeHarnessBackupExpiration } from "./native-harness-backup-expiration-notifications.js";
import { notifySkillVersionRetention } from "./skill-version-retention-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeEnvironmentSettlementScope = { companyId: string; runId?: string; issueId?: string; leaseId?: string };
export async function notifyNativeEnvironmentSettlement(tx: object, scope?: NativeEnvironmentSettlementScope) {
  await notifyNativeHarnessBackupExpiration(tx, scope);
  if (scope) await notifySkillVersionRetention(tx, scope.companyId);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeEnvironmentSettlement,
    scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}
