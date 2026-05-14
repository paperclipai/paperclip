import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "../issue-tree-control.js";

type IssueTreeControlService = ReturnType<typeof issueTreeControlService>;

export async function isAutomaticRecoverySuppressedByPauseHold(
  db: Db,
  companyId: string,
  issueId: string,
  treeControlSvc: IssueTreeControlService = issueTreeControlService(db),
  dbOrTx: Pick<Db, "select"> = db,
) {
  // dbOrTx: pass tx from inside db.transaction() to reuse the txn connection (BLO-3855).
  const activePauseHold = await treeControlSvc.getActivePauseHoldGate(companyId, issueId, dbOrTx);
  return Boolean(activePauseHold);
}
