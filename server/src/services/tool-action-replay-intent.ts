/** A fresh human request may ask for another review, never inherit approval.
 * These values come only from persisted run/comment rows, not tool arguments. */
interface ReplaySession {
  companyId: string; agentId: string | null; issueId: string | null; runId: string | null;
  responsibleUserId?: string | null;
}
interface ReplayRun {
  id: string; companyId: string; agentId: string; status: string; responsibleUserId: string | null;
  startedAt: Date | null; issueId?: string | null; nativeIssueId?: string | null;
  contextSnapshot: Record<string, unknown> | null;
}
interface HumanComment {
  id: string; companyId: string; issueId: string; authorType: string | null;
  authorUserId: string | null; authorAgentId: string | null; createdByRunId: string | null;
  derivedAuthorAgentId: string | null; derivedCreatedByRunId: string | null; derivedAuthorSource: string | null;
  deletedAt: Date | null; sourceTrust: unknown; presentation: { kind?: string } | null;
  createdAt: Date; body: string;
}
interface RejectedAction {
  companyId: string; issueId: string | null; status: string; requestedByAgentId: string | null;
  resolvedByUserId: string | null; decidedByUserId: string | null;
  resolvedByAgentId: string | null; decidedByAgentId: string | null;
  resolvedAt: Date | null; decidedAt: Date | null;
}
interface Invocation {
  companyId: string; issueId: string | null; agentId: string | null; runId: string | null;
}

export function isNewHumanIntentAfterToolRejection(input: {
  session: ReplaySession; rejection: RejectedAction; invocation: Invocation;
  run: ReplayRun; comment: HumanComment;
}): boolean {
  const { session, rejection, invocation, run, comment } = input;
  if (rejection.status !== "rejected" || !session.runId || !session.issueId || !session.agentId || !session.responsibleUserId
    || rejection.companyId !== session.companyId || rejection.issueId !== session.issueId || rejection.requestedByAgentId !== session.agentId
    || invocation.companyId !== session.companyId || invocation.issueId !== session.issueId || invocation.agentId !== session.agentId
    || !invocation.runId || invocation.runId === session.runId
    || run.id !== session.runId || run.companyId !== session.companyId || run.agentId !== session.agentId
    || run.status !== "running" || run.responsibleUserId !== session.responsibleUserId) return false;
  const context = run.contextSnapshot;
  if (!context || (context.source !== "issue.comment" && context.source !== "issue.comment.reopen") || context.commentId !== comment.id
    || context.issueId !== session.issueId
    || (context.taskId != null && context.taskId !== session.issueId)
    || (run.issueId != null && run.issueId !== session.issueId)
    || (run.nativeIssueId != null && run.nativeIssueId !== session.issueId)) return false;
  if (comment.companyId !== session.companyId || comment.issueId !== session.issueId
    || comment.authorType !== "user" || comment.authorUserId !== session.responsibleUserId
    || comment.authorAgentId || comment.createdByRunId || comment.derivedAuthorAgentId || comment.derivedCreatedByRunId
    || comment.derivedAuthorSource || comment.deletedAt || comment.sourceTrust != null
    || comment.presentation?.kind === "system_notice" || !comment.body.trim() || comment.body.trim() === "/new") return false;
  // A later request by a different person cannot override this person's decline.
  const deciders = [rejection.decidedByUserId, rejection.resolvedByUserId].filter(value => value != null);
  if (!deciders.length || deciders.some(value => value !== session.responsibleUserId)
    || rejection.resolvedByAgentId || rejection.decidedByAgentId) return false;
  const decisions = [rejection.decidedAt, rejection.resolvedAt].filter((value): value is Date => value != null);
  const times = decisions.map(value => value.getTime());
  const requestedAt = comment.createdAt.getTime(), startedAt = run.startedAt?.getTime();
  return times.length > 0 && times.every(Number.isFinite) && Number.isFinite(requestedAt) && Number.isFinite(startedAt)
    && Math.max(...times) < requestedAt && requestedAt <= startedAt! && startedAt! <= Date.now();
}
