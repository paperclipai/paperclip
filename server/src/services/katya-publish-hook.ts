import type { Db } from "@paperclipai/db";

export interface NotifyKatyaPublishApprovedInput {
  companyId: string;
  approvalId: string;
  approvalType: string;
  requestedByAgentId: string | null;
  linkedIssueIds: string[];
}

/**
 * Stub hook for Katya publish integration when approvals are approved.
 *
 * This is intentionally a no-op placeholder so callsites can integrate now
 * and wire concrete delivery behavior in a follow-up change.
 */
export async function notifyKatyaPublishApproved(
  _db: Db,
  _input: NotifyKatyaPublishApprovedInput,
): Promise<void> {
  return;
}
