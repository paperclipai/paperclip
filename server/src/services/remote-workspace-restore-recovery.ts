import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { REMOTE_WORKSPACE_RESTORE_FAILED_CODE } from "./remote-workspace-transport.js";
import { REMOTE_WORKSPACE_RESTORE_NEXT_ACTION } from "./recovery/stranded-notice.js";

type Run = typeof heartbeatRuns.$inferSelect;

// Stranded-work recovery scans these statuses and names this failure itself.
const STRANDED_RECOVERY_STATUSES = new Set(["todo", "in_progress", "in_review"]);
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/**
 * Leave a named board recovery action for a saved workspace that could not be
 * restored and will not be retried automatically. Stranded-work recovery owns
 * the statuses it scans; this covers the rest (for example a `blocked` task
 * woken by a reply), which would otherwise keep no recovery action at all.
 * An existing active action is kept, so no failure gets a second identity.
 */
export async function escalateRemoteWorkspaceRestoreFailure(db: Db, run: Run): Promise<boolean> {
  if (run.errorCode !== REMOTE_WORKSPACE_RESTORE_FAILED_CODE) return false;
  const contextIssueId = run.contextSnapshot?.issueId;
  const issueId = run.nativeIssueId ?? run.issueId ?? (typeof contextIssueId === "string" ? contextIssueId : null);
  if (!issueId) return false;
  const [issue] = await db.select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId })
    .from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
  if (!issue || TERMINAL_STATUSES.has(issue.status) || STRANDED_RECOVERY_STATUSES.has(issue.status)
    || issue.assigneeUserId || issue.assigneeAgentId !== run.agentId) return false;
  const recoveryActions = issueRecoveryActionService(db);
  if (await recoveryActions.getActiveForIssue(run.companyId, issue.id)) return false;
  const workspaceId = run.contextSnapshot?.executionWorkspaceId;
  await recoveryActions.upsertSourceScoped({
    companyId: run.companyId,
    sourceIssueId: issue.id,
    kind: "stranded_assigned_issue",
    ownerType: "board",
    returnOwnerAgentId: run.agentId,
    cause: REMOTE_WORKSPACE_RESTORE_FAILED_CODE,
    fingerprint: `remote-workspace-restore:${typeof workspaceId === "string" ? workspaceId : issue.id}`,
    evidence: {
      runId: run.id,
      originalFailureCode: run.errorCode,
      // The run error is the server-built, redacted restore cause.
      restoreFailure: run.error,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    },
    nextAction: REMOTE_WORKSPACE_RESTORE_NEXT_ACTION,
    maxAttempts: null,
    wakePolicy: null,
  });
  return true;
}
