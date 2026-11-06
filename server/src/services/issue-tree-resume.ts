import type { Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueTreeControlService } from "./issue-tree-control.js";

type ResumeActor = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

type Wakeup = (agentId: string, opts: {
  source: "assignment";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  requestedByActorType: ResumeActor["actorType"];
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

/**
 * Re-dispatch, once, the work a subtree pause interrupted on each task that is
 * no longer paused. Both a hold release and the executor that settles a
 * cancelled preparation call this, so neither ordering loses the work. A task
 * that still needs execution reconciliation keeps its blocker and is skipped;
 * its obligation stays unclaimed for a later settlement or release.
 */
export async function resumePauseInterruptedWork(
  db: Db,
  input: { companyId: string; issueIds: string[]; actor: ResumeActor; wakeup: Wakeup; rootIssueId?: string | null },
) {
  const treeControl = issueTreeControlService(db);
  const failures: Array<{ issueId: string; message: string }> = [];
  const activity = (action: string, entityType: string, entityId: string, details: Record<string, unknown>) =>
    logActivity(db, {
      companyId: input.companyId, actorType: input.actor.actorType, actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null, runId: input.actor.runId ?? null,
      agentApiKeyId: input.actor.agentApiKeyId ?? null, action, entityType, entityId, details,
    });
  for (const issueId of [...new Set(input.issueIds)]) {
    let claimed: { interruptedRunId: string } | null = null;
    try {
      const target = await treeControl.findOwedPauseResume(input.companyId, issueId);
      if (!target) continue;
      const blocker = await getExecutionBlocker(db, input.companyId, issueId);
      if (blocker) {
        await activity("issue.tree_resume_wake_skipped", "issue", issueId, {
          holdId: target.holdId, interruptedRunId: target.interruptedRunId, cause: blocker.cause,
        });
        continue;
      }
      if (!await treeControl.claimPauseResume(input.companyId, target.interruptedRunId, {
        holdId: target.holdId, claimedAt: new Date().toISOString(),
      })) continue;
      claimed = target;
      await input.wakeup(target.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_tree_resumed",
        payload: { issueId, rootIssueId: input.rootIssueId ?? null, holdId: target.holdId,
          interruptedRunId: target.interruptedRunId },
        requestedByActorType: input.actor.actorType,
        requestedByActorId: input.actor.actorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_tree_resumed",
          source: "issue.tree_resume",
          rootIssueId: input.rootIssueId ?? null,
          holdId: target.holdId,
          interruptedRunId: target.interruptedRunId,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ issueId, message });
      if (claimed) await treeControl.releasePauseResumeClaim(input.companyId, claimed.interruptedRunId).catch(() => null);
      await Promise.resolve(activity("issue.tree_resume_wake_failed", "issue", issueId, { error: message })).catch(() => null);
    }
  }
  return failures;
}
