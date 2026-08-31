import { useRef, useState } from "react";
import { ClipboardCheck, Loader2, ShieldCheck } from "lucide-react";
import type { Issue, IssueExecutionStageType } from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The one review/approval stage that the viewing user is being asked to decide.
 * Non-null only when the issue is parked on a `pending` execution stage whose
 * `currentParticipant` is this exact board user — the only case in which the
 * backend (`applyIssueExecutionStageTransition`) will accept an approve /
 * request-changes decision from them.
 */
export interface PendingExecutionDecision {
  stageType: IssueExecutionStageType;
  /** Instructions the assignee left for the reviewer, when present. */
  instructions: string | null;
}

/**
 * Pure visibility gate, split out so it is testable without a DOM and reusable
 * by callers that need to know whether the decision affordance should render at
 * all (mirrors `hasVisibleMonitorSurface`).
 *
 * A decision is actionable only when the issue is on a `pending` stage AND the
 * stage's `currentParticipant` is a board user matching the viewer. Agent
 * participants act through the API, never this widget, so they are excluded.
 */
export function getPendingExecutionDecision(
  issue: Pick<Issue, "executionState">,
  currentUserId: string | null,
): PendingExecutionDecision | null {
  const state = issue.executionState;
  if (!state || state.status !== "pending") return null;

  const participant = state.currentParticipant;
  if (!participant || participant.type !== "user" || !participant.userId)
    return null;
  if (!currentUserId || participant.userId !== currentUserId) return null;

  return {
    stageType: state.currentStageType ?? "review",
    instructions: state.reviewRequest?.instructions?.trim() || null,
  };
}

function stageLabel(stageType: IssueExecutionStageType): string {
  return stageType === "approval" ? "Approval" : "Review";
}

export interface IssueExecutionDecisionCardProps {
  issue: Issue;
  currentUserId: string | null;
  /** Approve the stage. The backend requires a non-empty comment. */
  onApprove: (comment: string) => Promise<unknown> | void;
  /** Send the issue back to its return assignee with requested changes. */
  onRequestChanges: (comment: string) => Promise<unknown> | void;
}

/**
 * Board decision affordance for the current review/approval-stage participant.
 * Rendered between the issue title and description (alongside the monitor
 * banner) when `getPendingExecutionDecision` matches the viewer.
 *
 * Mirrors the `request_confirmation` card's comment-required, two-action pattern
 * so a human on a stage can Approve (`PATCH { status: "done", comment }`) or
 * Request changes (`PATCH { status: "in_progress", comment }`) without
 * hand-rolling an API call. The comment is required to match backend validation
 * (`applyIssueExecutionStageTransition` throws 422 on an empty decision
 * comment), so both actions stay disabled until a comment is entered.
 */
export function IssueExecutionDecisionCard({
  issue,
  currentUserId,
  onApprove,
  onRequestChanges,
}: IssueExecutionDecisionCardProps) {
  const decision = getPendingExecutionDecision(issue, currentUserId);

  // Identity of the decision this card is currently editing. Changes when the
  // viewer navigates to a different actionable issue, realtime data advances
  // this issue to another pending stage, OR a request-changes round trip
  // returns the SAME issue to the SAME stage (a single-stage policy reuses its
  // one stage's id every cycle, so stage id alone cannot distinguish "still the
  // round I was already editing" from "a fresh round after the assignee's fix
  // landed"). `lastDecisionId` is stamped with a new randomUUID() on every
  // approve/request-changes decision (`server/src/routes/issues.ts`), including
  // the request-changes decision that sends work back — so it reliably changes
  // between rounds even when `currentStageId` does not.
  const decisionKey = decision
    ? `${issue.id}::${issue.executionState?.currentStageId ?? ""}::${issue.executionState?.lastDecisionId ?? ""}`
    : null;

  const [comment, setComment] = useState("");
  const [working, setWorking] = useState<"approve" | "request_changes" | null>(
    null,
  );
  const [activeKey, setActiveKey] = useState<string | null>(decisionKey);

  // Always holds the latest decision identity for in-flight async handlers to
  // read (a closure captures the key of the render it was created in, which
  // goes stale after a stage advance). Updating a ref during render is React's
  // documented "latest value" escape hatch and is safe here.
  const decisionKeyRef = useRef(decisionKey);
  decisionKeyRef.current = decisionKey;

  // Reset the in-progress comment when the decision target changes, so text
  // typed for one stage/issue can never be submitted against another. Adjusting
  // state during render (React's documented "store info from previous renders"
  // pattern) resets before paint — no stale, already-enabled textarea flashes.
  if (decisionKey !== activeKey) {
    setActiveKey(decisionKey);
    setComment("");
    setWorking(null);
  }

  if (!decision) return null;

  const label = stageLabel(decision.stageType);
  const trimmed = comment.trim();
  const canSubmit = trimmed.length > 0 && working === null;

  async function run(
    action: "approve" | "request_changes",
    handler: (comment: string) => Promise<unknown> | void,
  ) {
    if (!canSubmit) return;
    // Capture the decision this run belongs to. If the issue advances to another
    // pending stage while this PATCH is in flight, the render-time reset already
    // clears `working` for the new stage; without this guard the stale run's
    // `finally` would then clear the NEW run's `working`, re-enabling the buttons
    // mid-submit and allowing a duplicate decision.
    const startedKey = decisionKey;
    setWorking(action);
    try {
      await handler(trimmed);
    } finally {
      if (decisionKeyRef.current === startedKey) setWorking(null);
    }
  }

  return (
    <div
      role="group"
      aria-label={`${label} decision`}
      data-testid="issue-execution-decision-card"
      className="my-3 space-y-3 rounded-lg border-2 border-violet-500/70 bg-transparent p-4"
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300"
          aria-hidden="true"
        />
        <div className="space-y-0.5">
          <p className="text-sm font-medium leading-tight text-foreground">
            {label} — your decision is needed
          </p>
          <p className="text-xs leading-snug text-muted-foreground">
            Approve to advance this stage, or request changes to send it back to
            the assignee. A comment is required.
          </p>
        </div>
      </div>

      {decision.instructions ? (
        <div className="rounded-sm border-l-2 border-violet-500/60 bg-violet-500/5 px-3 py-2 text-sm leading-6 text-foreground">
          <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
            Review request
          </div>
          <p className="mt-0.5 whitespace-pre-wrap">{decision.instructions}</p>
        </div>
      ) : null}

      <Textarea
        aria-label={`${label} decision comment`}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Add a comment explaining your decision (required)"
        className="min-h-24 bg-background text-sm"
        disabled={working !== null}
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          disabled={!canSubmit}
          onClick={() => void run("approve", onApprove)}
        >
          {working === "approve" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Approving…
            </>
          ) : (
            "Approve"
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canSubmit}
          onClick={() => void run("request_changes", onRequestChanges)}
        >
          {working === "request_changes" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Requesting changes…
            </>
          ) : (
            <>
              <ClipboardCheck className="mr-2 h-3.5 w-3.5" />
              Request changes
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
