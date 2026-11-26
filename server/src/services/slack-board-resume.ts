import { type Db, type issues } from "@paperclipai/db";
import { isClosedIsolatedExecutionWorkspace } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService } from "./execution-workspaces.js";

/** The channel composer has no restore/workspace confirmation UI. Require the
 * ordinary task flow for those transitions instead of bypassing its guards. */
export async function assertSlackBoardWorkAllowed(db: Db, issue: typeof issues.$inferSelect) {
  if (issue.status === "cancelled") {
    throw conflict("Restore this task in Paperclip before sending work to Slack");
  }
  if (await issueTreeControlService(db).getActivePauseHoldGate(issue.companyId, issue.id)) {
    throw conflict("Task is paused. Resume it before sending a message.");
  }
  const readiness = await issueService(db).getDependencyReadiness(issue.id);
  if (readiness.unresolvedBlockerCount > 0) {
    throw conflict("Resolve this task's blockers in Paperclip before sending work to Slack");
  }
  if (issue.executionWorkspaceId) {
    const workspace = await executionWorkspaceService(db).getById(issue.executionWorkspaceId);
    if (
      !workspace ||
      workspace.companyId !== issue.companyId ||
      isClosedIsolatedExecutionWorkspace(workspace)
    ) {
      throw conflict("Reopen this task's workspace in Paperclip before sending work to Slack");
    }
  }
}
