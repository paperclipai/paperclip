import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { Issue, IssueThreadInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PROPERTIES_PANE_FOOTER_SLOT_ID } from "../PropertiesPanel";

/** The pending confirmation that targets the issue's `plan` document, if any. */
function findPendingPlanConfirmation(
  interactions: IssueThreadInteraction[] | undefined,
): RequestConfirmationInteraction | null {
  for (const interaction of interactions ?? []) {
    if (interaction.kind !== "request_confirmation") continue;
    if (interaction.status !== "pending") continue;
    const target = interaction.payload.target;
    if (target?.type === "issue_document" && target.key === "plan") return interaction;
  }
  return null;
}

interface IssuePlanConfirmationActionBarProps {
  issue: Issue;
  /** Inline hosts (mobile sheet) render the bar in place instead of portaling
   * it into the pane's pinned footer slot. */
  inline?: boolean;
}

/**
 * Sticky action bar for the Plan pane (flag: enableTaskChatRedesign): while a
 * plan confirmation is pending, its CTAs stay pinned below the pane's scroll
 * area so the board can approve or send back the plan without hunting for the
 * card in the thread. Mirrors the thread card's semantics (accept/reject labels
 * and the optional decline reason) against the same interactions API.
 */
export function IssuePlanConfirmationActionBar({ issue, inline }: IssuePlanConfirmationActionBarProps) {
  const queryClient = useQueryClient();
  const { data: interactions } = useQuery({
    queryKey: queryKeys.issues.interactions(issue.id),
    queryFn: () => issuesApi.listInteractions(issue.id),
  });
  const confirmation = findPendingPlanConfirmation(interactions);

  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (inline) {
      setFooterSlot(null);
      return;
    }
    setFooterSlot(document.getElementById(PROPERTIES_PANE_FOOTER_SLOT_ID));
  }, [inline]);

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectAttempted, setRejectAttempted] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issue.id) });
  };
  const accept = useMutation({
    mutationFn: (interactionId: string) => issuesApi.acceptInteraction(issue.id, interactionId),
    onSuccess: invalidate,
    onError: () => setActionError("Couldn't confirm — try again."),
  });
  const reject = useMutation({
    mutationFn: ({ interactionId, reason }: { interactionId: string; reason?: string }) =>
      issuesApi.rejectInteraction(issue.id, interactionId, reason),
    onSuccess: () => {
      setRejecting(false);
      setRejectReason("");
      invalidate();
    },
    onError: () => setActionError("Couldn't send that back — try again."),
  });

  // Interaction changed under us (resolved elsewhere, superseded): reset.
  useEffect(() => {
    setRejecting(false);
    setRejectReason("");
    setRejectAttempted(false);
    setActionError(null);
  }, [confirmation?.id, confirmation?.status]);

  if (!confirmation) return null;

  const working = accept.isPending ? "accept" : reject.isPending ? "reject" : null;
  const rejectRequiresReason = confirmation.payload.rejectRequiresReason === true;
  const allowDeclineReason = confirmation.payload.allowDeclineReason !== false;
  const trimmedReason = rejectReason.trim();
  const reasonInvalid = rejectRequiresReason && trimmedReason.length === 0;

  const handleReject = () => {
    setRejectAttempted(true);
    if (reasonInvalid) return;
    setActionError(null);
    reject.mutate({ interactionId: confirmation.id, reason: trimmedReason || undefined });
  };

  const bar = (
    <div
      data-testid="plan-pane-action-bar"
      className="space-y-2 border-t border-border bg-card p-3"
    >
      {rejecting ? (
        <div className="space-y-2">
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder={
              confirmation.payload.declineReasonPlaceholder
              ?? "Optional: what would you like revised?"
            }
            aria-invalid={rejectAttempted && reasonInvalid}
            className={cn(
              "min-h-20 bg-background text-sm",
              rejectAttempted && reasonInvalid && "border-rose-500 focus-visible:ring-rose-500/25",
            )}
          />
          {rejectAttempted && reasonInvalid ? (
            <p className="text-xs text-destructive">A decline reason is required.</p>
          ) : null}
        </div>
      ) : null}
      {actionError ? (
        <p className="text-xs text-destructive" role="alert">{actionError}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {rejecting ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={working !== null}
              onClick={() => {
                setRejecting(false);
                setRejectAttempted(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="outline" disabled={working !== null} onClick={handleReject}>
              {working === "reject" ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Sending back...
                </>
              ) : (
                confirmation.payload.rejectLabel ?? "Decline"
              )}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={working !== null}
            onClick={() => {
              if (!allowDeclineReason) {
                handleReject();
                return;
              }
              setRejectAttempted(false);
              setRejecting(true);
            }}
          >
            {working === "reject" ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Sending back...
              </>
            ) : (
              confirmation.payload.rejectLabel ?? "Decline"
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="cta"
          disabled={working !== null}
          onClick={() => {
            setActionError(null);
            accept.mutate(confirmation.id);
          }}
        >
          {working === "accept" ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Confirming...
            </>
          ) : (
            confirmation.payload.acceptLabel ?? "Confirm"
          )}
        </Button>
      </div>
    </div>
  );

  return footerSlot ? createPortal(bar, footerSlot) : bar;
}
