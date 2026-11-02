import { firstTaskScenario } from "./first-task-cases.js";
import type { FirstTaskEvidence, Row } from "./first-task-scoring.js";

/** A checkpoint label alone is not evidence that the user declined the work. */
export function firstTaskRejection(e: FirstTaskEvidence): Row | undefined {
  if (e.caseId !== "reject-no-execution") return undefined;
  const index = e.checkpoints.findIndex(c => c.phase === "rejected");
  const checkpoint = e.checkpoints[index];
  const before = e.checkpoints[index - 1];
  if (!checkpoint || !before) return undefined;
  const message = firstTaskScenario(e.caseId, e.nonce).rejection;
  return checkpoint.comments.find(c =>
    c.issueId === e.onboardingIssueId && c.authorUserId && !c.authorAgentId &&
    !c.deletedAt && c.body === message && !before.comments.some(old => old.id === c.id) &&
    Date.parse(c.createdAt) >= Date.parse(before.at),
  );
}

function isRejectionRun(run: Row, e: FirstTaskEvidence, rejection: Row) {
  return run.agentId === e.agentId &&
    run.contextSnapshot?.issueId === e.onboardingIssueId &&
    (run.contextSnapshot?.commentId === rejection.id || run.contextSnapshot?.wakeCommentId === rejection.id) &&
    Date.parse(run.startedAt) >= Date.parse(rejection.createdAt);
}

/** Closing the declined task can cancel its responding run. Defer judgement
 * until its reply is persisted; arbitrary operator cancellations stay failures. */
export function isFirstTaskRejectionCancellation(run: Row, e: FirstTaskEvidence, tasks: Row[]): boolean {
  const rejection = firstTaskRejection(e);
  return Boolean(rejection && isRejectionRun(run, e, rejection) &&
    run.status === "cancelled" && run.errorCode === "cancelled" &&
    run.error === "Cancelled by control plane" &&
    Date.parse(run.finishedAt) >= Date.parse(run.startedAt) &&
    tasks.some(t => t.id === e.onboardingIssueId && t.status === "cancelled"));
}

/** Require a saved response from the refusal turn, not an earlier proposal. */
export function firstTaskRejectionReplyRecorded(e: FirstTaskEvidence, comments: Row[], runs: Row[]): boolean {
  const rejection = firstTaskRejection(e);
  if (!rejection) return false;
  const replyRuns = new Set(runs.filter(run => isRejectionRun(run, e, rejection)).map(run => run.id));
  return comments.some(c => c.issueId === e.onboardingIssueId && c.authorAgentId === e.agentId &&
    !c.deletedAt && typeof c.body === "string" && c.body.trim().length > 0 &&
    replyRuns.has(c.createdByRunId) && Date.parse(c.createdAt) >= Date.parse(rejection.createdAt));
}
