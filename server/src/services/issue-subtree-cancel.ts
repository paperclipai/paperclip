import type { Db } from "@paperclipai/db";
import { issueTreeControlService } from "./issue-tree-control.js";
import { logActivity } from "./activity-log.js";

interface SubtreeCancelHeartbeat {
  cancelRun(runId: string): Promise<unknown>;
}

export interface SubtreeCancelActor {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
}

export interface SubtreeCancelResult {
  holdId: string | null;
  runsCancelled: number;
  wakeupsCancelled: number;
  statusesCancelled: number;
}

// Cancel an entire issue subtree: create a cancel tree-hold, interrupt active
// runs, cancel unclaimed wakeups, and flip workable descendants to cancelled.
// Reuses the same engine the `POST /issues/:id/tree-holds` route drives, so plan
// Stop and the budget hard-stop share one well-tested cancellation path.
//
// Safe no-op: if nothing is running/queued, returns zero counts without error.
export async function cancelIssueSubtree(
  db: Db,
  deps: { heartbeat: SubtreeCancelHeartbeat },
  root: { id: string; companyId: string },
  actor: SubtreeCancelActor,
  reason: string,
): Promise<SubtreeCancelResult> {
  const treeControl = issueTreeControlService(db);
  const actorInput = {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.userId,
    runId: actor.runId,
  };

  const result = await treeControl.createHold(root.companyId, root.id, {
    mode: "cancel",
    reason,
    actor: actorInput,
  });

  const interruptedRunIds = [...new Set(result.preview.activeRuns.map((run) => run.id))];
  let runsCancelled = 0;
  for (const runId of interruptedRunIds) {
    try {
      await deps.heartbeat.cancelRun(runId);
      runsCancelled += 1;
    } catch {
      // Best-effort: a run may already have terminated.
    }
  }

  const cancelledWakeups = await treeControl.cancelUnclaimedWakeupsForTree(
    root.companyId,
    root.id,
    reason,
  );

  const statusUpdate = await treeControl.cancelIssueStatusesForHold(
    root.companyId,
    root.id,
    result.hold.id,
  );

  await logActivity(db, {
    companyId: root.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    action: "issue.tree_cancel_status_updated",
    entityType: "issue",
    entityId: root.id,
    details: {
      holdId: result.hold.id,
      reason,
      runsCancelled,
      wakeupsCancelled: cancelledWakeups.length,
      cancelledIssueIds: statusUpdate.updatedIssueIds,
    },
  });

  return {
    holdId: result.hold.id,
    runsCancelled,
    wakeupsCancelled: cancelledWakeups.length,
    statusesCancelled: statusUpdate.updatedIssueIds.length,
  };
}
