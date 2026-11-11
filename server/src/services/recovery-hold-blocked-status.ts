import type { heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { nativeWorkspaceFinalizationBlockSchema } from "./native-runtime/preserved-native-result-finalization.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Whether the task's Blocked status still belongs to this recovery hold: its
 * own receipt names the current status version or, for holds saved before
 * receipts existed, this run's terminal failure set the block and nothing
 * changed it since. Otherwise a newer decision owns the block, and settling the
 * hold must keep it.
 */
export function holdOwnsBlockedStatus(
  action: Pick<typeof issueRecoveryActions.$inferSelect, "evidence" | "createdAt">,
  issue: Pick<typeof issues.$inferSelect, "id" | "status" | "statusVersion" | "lastStatusDecisionId" | "blockedTransitionAt">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "finishedAt">,
): boolean {
  const block = nativeWorkspaceFinalizationBlockSchema.safeParse(action.evidence.workspaceFinalizationBlock);
  // A native no-replay hold records the Blocked status version its run's failure set.
  const failureBlock = object(action.evidence.nativeFailureBlock);
  const blockedAt = issue.blockedTransitionAt?.getTime();
  return issue.status === "blocked" && (block.success
    ? block.data.issueId === issue.id && block.data.runId === run.id
      && block.data.statusVersion === Number(issue.statusVersion) && block.data.priorDecisionId === issue.lastStatusDecisionId
    : action.evidence.nativeFailureBlock !== undefined
      ? failureBlock.runId === run.id && failureBlock.statusVersion === Number(issue.statusVersion)
      : action.evidence.workspaceFinalizationBlock === undefined && issue.lastStatusDecisionId === null && blockedAt !== undefined
        && run.finishedAt !== null && blockedAt >= run.finishedAt.getTime() - 1_000 && blockedAt <= action.createdAt.getTime() + 60_000);
}
