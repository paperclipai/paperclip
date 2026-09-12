import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

interface StageDecisionActionsProps {
  issueId: string;
  companyId: string;
  stageType: "review" | "approval";
  commentRequired: boolean;
  className?: string;
  onResolved?: () => void;
}

/** Submit a human execution-stage decision and its comment atomically. */
export function StageDecisionActions({
  issueId,
  companyId,
  stageType,
  commentRequired,
  className,
  onResolved,
}: StageDecisionActionsProps) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve" | "request_changes" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const commentEmpty = comment.trim().length === 0;
  const stageLabel = stageType === "review" ? "review" : "approval";

  const submit = (status: "done" | "in_progress", action: "approve" | "request_changes") => {
    if (pendingAction || (commentRequired && commentEmpty)) return;
    setPendingAction(action);
    setErrorMessage(null);

    issuesApi.update(issueId, {
      status,
      ...(commentEmpty ? {} : { comment: comment.trim() }),
    })
      .then(() => {
        setResolved(true);
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.commentsList(issueId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.decisionQueues.list(companyId) });
        onResolved?.();
      })
      .catch((error: unknown) => {
        setErrorMessage(
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Unable to record the stage decision. Please try again.",
        );
      })
      .finally(() => {
        setPendingAction(null);
      });
  };

  const pending = pendingAction !== null;
  const commentHint = commentRequired
    ? `A decision comment is required for this ${stageLabel} stage.`
    : `Optional ${stageLabel} decision comment.`;

  if (resolved) return null;

  return (
    <div className={cn("space-y-2", className)} data-testid="stage-decision-actions">
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        aria-label={`${stageLabel === "review" ? "Review" : "Approval"} decision comment`}
        placeholder={commentHint}
        className="min-h-16 text-sm"
        data-testid="stage-decision-comment"
        disabled={pending}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || (commentRequired && commentEmpty)}
          title={commentRequired && commentEmpty ? "Add a comment to request changes" : undefined}
          onClick={() => submit("in_progress", "request_changes")}
          data-testid="stage-decision-request-changes"
        >
          {pendingAction === "request_changes" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          )}
          Request changes
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || (commentRequired && commentEmpty)}
          title={commentRequired && commentEmpty ? "Add a comment to approve this stage" : undefined}
          onClick={() => submit("done", "approve")}
          data-testid="stage-decision-approve"
        >
          {pendingAction === "approve" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          )}
          Approve
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
