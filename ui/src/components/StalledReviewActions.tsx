import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, RotateCcw, Undo2 } from "lucide-react";
import type { IssueReviewPolicy, StalledReviewDecisionAction } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { issueReviewPolicyBadge } from "../lib/review-policy";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

interface StalledReviewActionsProps {
  issueId: string;
  companyId: string;
  /** Rendered at the left of the action row — e.g. a decisions-row disclosure toggle. */
  footerSlot?: ReactNode;
  /** Fired after a decision lands so the surface can navigate / close / refetch extras. */
  onResolved?: (action: StalledReviewDecisionAction) => void;
  /**
   * The issue's `reviewPolicy` (PAP-16506). Only an opt-in constraint is shown;
   * the default — `null`/`"anyone"` — renders nothing, because "anyone can
   * approve" is what every issue already does.
   */
  reviewPolicy?: IssueReviewPolicy | null;
  className?: string;
}

const ACTION_PAST_TENSE: Record<StalledReviewDecisionAction, string> = {
  approve: "Review approved — issue marked done.",
  request_changes: "Changes requested — issue returned to the assignee.",
  send_back: "Sent back to work — issue returned to the assignee.",
};

/**
 * The three review verbs an operator can take on a *stalled* in-review issue —
 * one with no reviewer, interaction, approval, or monitor path left (PAP-16080
 * §4.4). Shared by the issue-page review panel and the /decisions card so both
 * surfaces resolve the same way: POST /issues/:id/stalled-review-decision.
 *
 * `request_changes` requires a note (mirrors `stalledReviewDecisionSchema`);
 * `approve` and `send_back` take the note optionally. Approve → `done`; the
 * other two → `todo` and dispatch the assignee a resume wake carrying the note.
 */
export function StalledReviewActions({
  issueId,
  companyId,
  footerSlot,
  onResolved,
  reviewPolicy,
  className,
}: StalledReviewActionsProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [note, setNote] = useState("");

  const decide = useMutation({
    mutationFn: (action: StalledReviewDecisionAction) =>
      issuesApi.decideStalledReview(issueId, {
        action,
        note: note.trim() ? note.trim() : undefined,
      }),
    onSuccess: (_result, action) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) });
      setNote("");
      pushToast({ title: ACTION_PAST_TENSE[action], tone: "success" });
      onResolved?.(action);
    },
    onError: (error) => {
      pushToast({
        title: "Could not record the review decision",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  const pending = decide.isPending;
  const noteEmpty = note.trim().length === 0;
  const runningFor = (action: StalledReviewDecisionAction) =>
    pending && decide.variables === action;
  const policyBadge = issueReviewPolicyBadge(reviewPolicy);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Only a constrained policy gets a badge: the server refuses a verdict
          from the wrong actor, so the card has to warn before offering Approve.
          The default needs no line — anyone with write access can approve. */}
      {policyBadge ? (
        <Badge
          variant="outline"
          className="max-w-full min-w-0 self-start font-normal"
          data-testid="review-policy-badge"
          data-review-policy={policyBadge.value}
          title={policyBadge.description}
        >
          <policyBadge.Icon aria-hidden />
          <span className="min-w-0 truncate">{policyBadge.label}</span>
        </Badge>
      ) : null}
      <Textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Add a note — required to request changes, optional otherwise…"
        className="min-h-16 text-sm"
        data-testid="stalled-review-note"
        disabled={pending}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        {footerSlot ?? <span className="hidden sm:block" />}
        <div className="flex flex-col gap-2 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end @xl:flex-none">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full sm:w-auto sm:flex-1 @xl:flex-none"
            disabled={pending}
            onClick={() => decide.mutate("send_back")}
            data-testid="stalled-review-send-back"
          >
            {runningFor("send_back") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Send back to work
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full border-amber-400/70 text-amber-900 hover:bg-amber-100 dark:border-amber-500/50 dark:text-amber-100 dark:hover:bg-amber-500/15 sm:w-auto sm:flex-1 @xl:flex-none"
            disabled={pending || noteEmpty}
            title={noteEmpty ? "Add a note to request changes" : undefined}
            onClick={() => decide.mutate("request_changes")}
            data-testid="stalled-review-request-changes"
          >
            {runningFor("request_changes") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            )}
            Request changes
          </Button>
          <Button
            type="button"
            size="sm"
            className="w-full sm:w-auto sm:flex-1 @xl:flex-none"
            disabled={pending}
            onClick={() => decide.mutate("approve")}
            data-testid="stalled-review-approve"
          >
            {runningFor("approve") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
