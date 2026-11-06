import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isAgentStatusInvokable, type Agent, type TaskInterruptionPresentation } from "@paperclipai/shared";
import type { IssueChatComment, IssueChatLinkedRun } from "@/lib/issue-chat-messages";
import { CommentSubmissionUnknownError } from "@/lib/comment-submit-result";
import { isTerminalIssueStatus } from "@/lib/liveIssueIds";

interface Submission {
  attemptId: number;
  issueId: string | null;
  agentId: string;
  previousAgentId: string | null;
  runIds: Set<string>;
  clientRequestId: string;
  interruptionKey: string;
  takingLonger: boolean;
}

type SubmissionAgent = Partial<Pick<Agent, "status" | "orgChainHealth">>;

function agentBlocksStartup(agent: SubmissionAgent | undefined) {
  return (agent?.status !== undefined && !isAgentStatusInvokable(agent.status)) ||
    agent?.orgChainHealth?.status === "invalid_org_chain";
}

export function useRunnerSubmission({
  issueId,
  agentId,
  agent,
  blocked = false,
  comments,
  issueStatus,
  runId,
  linkedRuns = [],
  interruption,
  onRefresh,
}: {
  issueId: string | null;
  agentId: string | null;
  agent?: SubmissionAgent;
  blocked?: boolean;
  comments: readonly IssueChatComment[];
  issueStatus?: string;
  runId: string | null;
  linkedRuns?: readonly IssueChatLinkedRun[];
  interruption?: TaskInterruptionPresentation | null;
  onRefresh?: () => void | Promise<unknown>;
}) {
  const [submission, setSubmission] = useState<Submission | null>(null);
  const nextAttemptId = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const interruptionKey = JSON.stringify([
    interruption?.intentId, interruption?.state, interruption?.observedRunId,
  ]);
  // A reassignment can still be saving. The previous assignee's availability
  // does not decide whether the selected recipient can respond.
  const startupBlocked = blocked ||
    ((!submission || submission.agentId === agentId) && agentBlocksStartup(agent));
  const savedComment = submission && comments.find(comment =>
    comment.clientRequestId === submission.clientRequestId && !comment.clientStatus);
  const acknowledgedAt = savedComment ? new Date(savedComment.createdAt).getTime() : null;
  const submissionRuns = submission && savedComment ? linkedRuns.filter(run =>
    run.agentId === submission.agentId && (
      run.runId === savedComment.consumedByRunId || run.runId === savedComment.steeredIntoRunId ||
      (!submission.runIds.has(run.runId) && acknowledgedAt !== null &&
        new Date(run.createdAt).getTime() >= acknowledgedAt)
    )) : [];
  const settled = Boolean(submission && (
    runId || startupBlocked || isTerminalIssueStatus(issueStatus) ||
    (submission.agentId !== agentId && submission.previousAgentId !== agentId) ||
    (submission.issueId && submission.issueId !== issueId) ||
    (interruption && interruption.state !== "working" &&
      interruptionKey !== submission.interruptionKey &&
      (interruption.intentId !== null ||
        submissionRuns.some(run => run.runId === interruption.observedRunId))) ||
    submissionRuns.some(run =>
      run.status !== "queued" && run.status !== "running")
  ));
  const pending = submission !== null && !settled;
  const takingLonger = submission?.takingLonger ?? false;
  const attemptId = submission?.attemptId;

  useLayoutEffect(() => {
    if (settled) {
      setSubmission(null);
    }
  }, [settled]);

  useEffect(() => {
    if (!pending) return;
    const timeout = window.setTimeout(() => {
      setSubmission(current => current && current.attemptId === attemptId
        ? { ...current, takingLonger: true } : current);
      void refreshRef.current?.();
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [pending, attemptId]);

  const begin = useCallback((clientRequestId: string, recipient?: { agentId: string | null; agent?: SubmissionAgent }) => {
    const targetAgentId = recipient ? recipient.agentId : agentId;
    const targetAgent = recipient ? recipient.agent : agent;
    const next: Submission | null = targetAgentId && !blocked && !agentBlocksStartup(targetAgent) ? {
      issueId, agentId: targetAgentId, previousAgentId: agentId, interruptionKey, clientRequestId,
      attemptId: ++nextAttemptId.current, takingLonger: false,
      runIds: new Set(linkedRuns.map(run => run.runId)),
    } : null;
    setSubmission(next);
    return next?.attemptId ?? null;
  }, [agentId, agent, blocked, issueId, interruptionKey, linkedRuns]);

  const reject = useCallback((attempt: number | null, error: unknown) => {
    setSubmission(current => {
      if (!current || current.attemptId !== attempt) return current;
      return error instanceof CommentSubmissionUnknownError
        ? { ...current, takingLonger: true } : null;
    });
  }, []);

  return { pending, agentId: pending ? submission.agentId : null, takingLonger, begin, reject, blocked: startupBlocked };
}
