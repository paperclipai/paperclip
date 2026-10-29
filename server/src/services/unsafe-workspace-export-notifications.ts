import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type UnsafeWorkspaceExportScope = { companyId: string; issueId?: string };

export async function notifyUnsafeWorkspaceExportRecovery(transaction: object, scope: UnsafeWorkspaceExportScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.unsafeWorkspaceExportRecovery,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}

export async function notifyUnsafeWorkspaceExportRunChange(transaction: object, run: {
  companyId: string; nativeIssueId: string | null; contextSnapshot: Record<string, unknown> | null;
}) {
  const contextIssueId = run.contextSnapshot?.issueId;
  const issueIds = new Set([run.nativeIssueId, typeof contextIssueId === "string" ? contextIssueId : null]);
  for (const issueId of issueIds) if (issueId) await notifyUnsafeWorkspaceExportRecovery(transaction, { companyId: run.companyId, issueId });
}
