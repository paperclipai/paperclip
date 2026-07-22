export function issueAwaitsHumanApproval(
  issueId: string,
  pendingIssueIds: ReadonlySet<string>,
): boolean {
  return pendingIssueIds.has(issueId);
}

export function outreachApprovalContinuationPolicy(): "wake_assignee" {
  // Approval and Hold are both instructions to REV-06. Accept continues to the
  // single-use send; Hold continues to a revised draft that incorporates the
  // owner's reason. An accept-only wake strands rejected outreach in review.
  return "wake_assignee";
}

export function outreachApprovalSupersedesOnUserComment(): true {
  // A normal reply in the task thread is the most natural way to request an
  // edit. Treat it as feedback on the pending draft, clear that stale card,
  // and let the continuation wake produce one corrected approval.
  return true;
}

export function interactionClosesPendingOutreach(
  status: string | null | undefined,
): boolean {
  return status === "rejected" || status === "expired";
}

export function outboxSendCompletionState(): {
  interactionStatus: "accepted";
  interactionOutcome: "accepted";
  completionSurface: "outreach_outbox";
  issueStatus: "done";
} {
  // The task card and Outreach outbox are two controls for one decision. A
  // successful send from the outbox therefore has the same terminal business
  // state as accepting the task card and completing its single-use send.
  return {
    interactionStatus: "accepted",
    interactionOutcome: "accepted",
    completionSurface: "outreach_outbox",
    issueStatus: "done",
  };
}

export function acceptedApprovalGateFailureState(): {
  interactionStatus: "rejected";
  interactionOutcome: "rejected";
  outboxStatus: "cancelled";
} {
  // An approval authorizes one exact copy. If a newer safety gate invalidates
  // that copy, the authorization cannot remain accepted/unused: that makes the
  // runner retry an impossible send forever. Close both representations and
  // let REV-06 produce a newly reviewed copy for a fresh human decision.
  return {
    interactionStatus: "rejected",
    interactionOutcome: "rejected",
    outboxStatus: "cancelled",
  };
}

export function approvalQueueCollision(
  currentIssueId: string,
  canonicalIssueId: string | null | undefined,
): { sameIssue: boolean; issueStatus: "in_review" | "cancelled" } {
  const sameIssue = Boolean(canonicalIssueId) && canonicalIssueId === currentIssueId;
  return {
    sameIssue,
    issueStatus: sameIssue ? "in_review" : "cancelled",
  };
}
