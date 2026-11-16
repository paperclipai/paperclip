import type { Db, heartbeatRuns } from "@paperclipai/db";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "../native-runtime/native-review-participant.js";

export async function hasReviewPoolAllocation(db: Db, run: typeof heartbeatRuns.$inferSelect, taskKey: string) {
  const review = readNativeReviewAssignmentContext(run.contextSnapshot);
  if (run.runtimeMode !== "native" || run.scopeKind !== "issue" || !run.issueId ||
      run.nativeIssueId !== run.issueId || !review || taskKey !== `native-review:${review.nativeReviewInteractionId}`) return false;
  return Boolean(await getNativeReviewAssignment(db, { companyId: run.companyId, issueId: run.issueId,
    agentId: run.agentId, contextSnapshot: run.contextSnapshot, allowResolvedByRunId: run.id }));
}
