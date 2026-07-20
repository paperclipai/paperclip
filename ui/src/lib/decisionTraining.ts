import type { AttentionItem, DecisionTrainingSnapshotV1 } from "@paperclipai/shared";
import type { DecisionTrainingTarget } from "../api/decisionTraining";

/**
 * Resolve the durable (source + issue) target a Decisions row would train
 * against, or `null` when the row is not trainable.
 *
 * v1 trains two source kinds — board approvals and issue-thread interactions —
 * and always anchors to the owning issue. An
 * approval that is not linked to any issue has no durable anchor, so it is not
 * trainable and returns `null`.
 */
export function trainingTargetForItem(item: AttentionItem): DecisionTrainingTarget | null {
  const metadataIssueId = typeof item.subject.metadata?.issueId === "string"
    ? item.subject.metadata.issueId
    : null;
  const issueId = metadataIssueId ?? item.relatedIssue?.id ?? null;
  if (!issueId) return null;

  if (item.sourceKind === "issue_thread_interaction") {
    return { sourceKind: "interaction", sourceId: item.subject.id, issueId };
  }
  if (item.sourceKind === "approval") {
    return { sourceKind: "approval", sourceId: item.subject.id, issueId };
  }
  return null;
}

/** Whether a Decisions row should surface the train affordance at all. */
export function isTrainable(item: AttentionItem): boolean {
  return trainingTargetForItem(item) !== null;
}

/** Human label for how confidently a code commit was resolved for the snapshot. */
export function codeResolutionLabel(resolution: DecisionTrainingSnapshotV1["code"]["resolution"]): string {
  switch (resolution) {
    case "exact":
      return "exact (from the deciding run)";
    case "nearest_run":
      return "nearest run before cutoff";
    case "workspace":
      return "workspace default";
    case "none":
      return "no commit found";
  }
}
