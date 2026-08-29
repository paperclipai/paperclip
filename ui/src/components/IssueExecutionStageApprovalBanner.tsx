import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { InlineBanner } from "./InlineBanner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type ExecutionStageStatusIssue = Pick<Issue, "id" | "executionState">;

/**
 * True when `issue`'s pending execution-policy review/approval stage is
 * waiting on `userId` specifically. `applyIssueExecutionPolicyTransition`
 * (server/src/services/issue-execution-policy.ts) only accepts a decision
 * from this exact principal — everyone else's status PATCH falls through
 * untouched, so the UI must gate on the same match (MYLA-785).
 */
export function isExecutionStagePendingForUser(
  issue: ExecutionStageStatusIssue | null | undefined,
  userId: string | null | undefined,
): boolean {
  const state = issue?.executionState;
  if (!state || state.status !== "pending" || !userId) return false;
  const participant = state.currentParticipant;
  return participant?.type === "user" && participant.userId === userId;
}

export interface IssueExecutionStageApprovalBannerProps {
  issue: Issue;
  currentUserId: string | null;
}

/**
 * Approving or requesting changes on a pending review/approval stage requires
 * a comment in the same PATCH (the backend 422s otherwise). Before this
 * banner, the only status control was the bare status-badge dropdown, which
 * sends no comment — the reviewer had no first-class way to act (MYLA-785).
 */
export function IssueExecutionStageApprovalBanner({
  issue,
  currentUserId,
}: IssueExecutionStageApprovalBannerProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [comment, setComment] = useState("");

  const decide = useMutation({
    mutationFn: (status: "done" | "in_progress") =>
      issuesApi.update(issue.id, { status, comment: comment.trim() }),
    onSuccess: (_result, status) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issue.id) });
      setComment("");
      pushToast({
        title: status === "done" ? "Approved — issue marked done." : "Changes requested.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not record the review decision",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!isExecutionStagePendingForUser(issue, currentUserId)) return null;

  const pending = decide.isPending;
  const commentEmpty = comment.trim().length === 0;
  const stageLabel = issue.executionState?.currentStageType === "approval" ? "approval" : "review";

  return (
    <div data-testid="issue-execution-stage-approval-banner">
      <InlineBanner tone="warning" title={`Your ${stageLabel} is requested`} className="my-3">
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Add a comment — required to approve or request changes…"
            className="min-h-16 bg-background text-sm"
            disabled={pending}
            data-testid="issue-execution-stage-approval-comment"
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || commentEmpty}
              title={commentEmpty ? "Add a comment to request changes" : undefined}
              onClick={() => decide.mutate("in_progress")}
              data-testid="issue-execution-stage-request-changes"
            >
              {pending && decide.variables === "in_progress" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              Request changes
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={pending || commentEmpty}
              title={commentEmpty ? "Add a comment to approve" : undefined}
              onClick={() => decide.mutate("done")}
              data-testid="issue-execution-stage-approve"
            >
              {pending && decide.variables === "done" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
              )}
              Approve
            </Button>
          </div>
        </div>
      </InlineBanner>
    </div>
  );
}
