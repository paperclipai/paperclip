import { useState } from "react";
import { CheckCircle2, Undo2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { Issue, IssueExecutionStageType } from "@paperclipai/shared";

export type IssueExecutionStageDecision = "approve" | "request_changes";

/**
 * Returns the pending review/approval execution stage the given board user must
 * decide on, or null when no decision affordance should be rendered.
 *
 * The board user is the decision-maker whenever they are the stage's
 * `currentParticipant` — independent of whether the issue's assignee was also
 * driven to them (NEO-500: the server's orphan-repair treats
 * `assignee == currentParticipant` as "affordance present", so the UI must
 * actually render one in that state).
 */
export function pendingExecutionStageForUser(
  issue: Issue,
  currentUserId: string | null,
): { stageType: Extract<IssueExecutionStageType, "review" | "approval">; instructions: string | null } | null {
  if (!currentUserId) return null;
  if (issue.status === "done" || issue.status === "cancelled") return null;
  const state = issue.executionState;
  if (!state || state.status !== "pending") return null;
  if (state.currentStageType !== "review" && state.currentStageType !== "approval") return null;
  const participant = state.currentParticipant;
  if (!participant || participant.type !== "user" || participant.userId !== currentUserId) return null;
  return {
    stageType: state.currentStageType,
    instructions: state.reviewRequest?.instructions ?? null,
  };
}

export function IssueExecutionStageDecisionCard({
  issue,
  currentUserId,
  onDecide,
  isPending = false,
  pendingDecision = null,
}: {
  issue: Issue;
  currentUserId: string | null;
  onDecide: (decision: IssueExecutionStageDecision, comment: string) => void;
  isPending?: boolean;
  pendingDecision?: IssueExecutionStageDecision | null;
}) {
  const [comment, setComment] = useState("");
  const stage = pendingExecutionStageForUser(issue, currentUserId);
  if (!stage) return null;

  const stageLabel = stage.stageType === "review" ? "Review" : "Approval";
  const roleLabel = stage.stageType === "review" ? "reviewer" : "approver";
  const trimmedComment = comment.trim();

  return (
    <Card className="border-amber-500/40 bg-amber-500/5 p-4" data-testid="execution-stage-decision-card">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-500/40 bg-background/80">
          <ShieldCheck className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{stageLabel} requested</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            You are the {roleLabel} for this task's {stage.stageType} stage. Approving moves the
            task forward; requesting changes returns it to the assignee.
          </p>
          {stage.instructions ? (
            <p className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
              {stage.instructions}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 space-y-2">
        <Textarea
          value={comment}
          onChange={(evt) => setComment(evt.target.value)}
          placeholder="Decision comment (required)"
          disabled={isPending}
          className="min-h-20"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="bg-green-700 text-white hover:bg-green-600"
            disabled={isPending || trimmedComment.length === 0}
            onClick={() => onDecide("approve", trimmedComment)}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            {pendingDecision === "approve" ? "Approving..." : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending || trimmedComment.length === 0}
            onClick={() => onDecide("request_changes", trimmedComment)}
          >
            <Undo2 className="h-3.5 w-3.5" />
            {pendingDecision === "request_changes" ? "Sending..." : "Request changes"}
          </Button>
          {trimmedComment.length === 0 ? (
            <span className="text-xs text-muted-foreground">Add a comment to enable the decision buttons.</span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
