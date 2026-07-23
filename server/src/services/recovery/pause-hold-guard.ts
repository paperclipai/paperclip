import type { Db } from "@paperclipai/db";
import { isIssueProductivityReviewOriginKind } from "@paperclipai/shared";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
  originKind?: string | null,
) {
  if (isIssueProductivityReviewOriginKind(originKind)) return false;
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
  return Boolean(activePauseHold);
}
