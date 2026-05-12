import type {
  IssueOrphanDeliverableSignal,
  IssueOrphanDeliverableStatus,
} from "@paperclipai/shared";

export const ORPHAN_DELIVERABLE_GRACE_MS = 15 * 60 * 1000;

const ORPHAN_ELIGIBLE_STATUSES: ReadonlySet<IssueOrphanDeliverableStatus> = new Set([
  "in_progress",
  "in_review",
  "done",
]);

function isOrphanEligibleStatus(status: string): status is IssueOrphanDeliverableStatus {
  return ORPHAN_ELIGIBLE_STATUSES.has(status as IssueOrphanDeliverableStatus);
}

export interface OrphanDeliverableInput {
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  hasNonSystemDocuments: boolean;
  hasAgentComments: boolean;
  now?: Date;
  graceMs?: number;
}

// Identifies issues that look like they've shipped (status moved off `todo`/`backlog`)
// but have no deliverable artifact attached — no documents and no agent-authored
// comments. This is the failure mode where a research-deliverable heartbeat flips
// status but exits before saving the artifact (see ZERA-541).
//
// The grace period (default 15 min) absorbs in-flight agents that have only just
// flipped status. We use `completedAt` as the reference for `done` and `startedAt`
// for `in_progress`/`in_review` so the signal aligns with the relevant transition.
export function computeOrphanDeliverableSignal(
  input: OrphanDeliverableInput,
): IssueOrphanDeliverableSignal | null {
  if (input.hasNonSystemDocuments || input.hasAgentComments) return null;
  if (!isOrphanEligibleStatus(input.status)) return null;

  const reference = input.status === "done" ? input.completedAt : input.startedAt;
  if (!reference) return null;

  const graceMs = input.graceMs ?? ORPHAN_DELIVERABLE_GRACE_MS;
  const flaggedSince = new Date(reference.getTime() + graceMs);
  const now = input.now ?? new Date();
  if (now < flaggedSince) return null;

  return {
    reason: "no_documents_no_agent_comments",
    status: input.status,
    flaggedSince,
    hasDocuments: false,
    hasAgentComments: false,
  };
}
