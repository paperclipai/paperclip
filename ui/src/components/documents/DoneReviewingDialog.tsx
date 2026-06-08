import { useEffect, useState } from "react";
import type { DocumentReviewIndexCounts } from "@paperclipai/shared";
import { CheckCircle2, MessageSquare, Bell } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

/** Payload emitted when the reviewer confirms the handoff. */
export interface DoneReviewingHandoff {
  /** Trimmed overall comment (empty string when the reviewer left none). */
  overallComment: string;
  /** Post a structured summary comment on the linked issue (wakes the assignee). */
  commentOnLinkedIssue: boolean;
  /** Fire a structured owner wake (request_confirmation against the latest revision). */
  wakeOwner: boolean;
}

export interface DoneReviewingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  counts?: DocumentReviewIndexCounts;
  /**
   * When the review index couldn't be loaded (e.g. the viewer lacks parent-issue
   * access), surface this message instead of misleading zero stats.
   */
  accessError?: string | null;
  /** Linked issue identifier, used to label the "comment on issue" toggle. */
  issueIdentifier?: string | null;
  /** Owner agent display name, used to label the "wake owner" toggle. */
  ownerName?: string | null;
  /** When false the owner-wake toggle is disabled (no resolvable owner / revision). */
  canWakeOwner?: boolean;
  submitting?: boolean;
  onSubmit: (handoff: DoneReviewingHandoff) => Promise<void> | void;
}

interface SummaryStat {
  label: string;
  value: number;
  tone: "default" | "warn";
}

function buildStats(counts: DocumentReviewIndexCounts | undefined): SummaryStat[] {
  const c = counts;
  return [
    { label: "Open comments", value: (c?.openAnchoredThreads ?? 0) + (c?.openReviewThreads ?? 0), tone: "default" },
    { label: "Suggestions", value: c?.pendingSuggestions ?? 0, tone: "default" },
    { label: "Stale", value: c?.staleAnchors ?? 0, tone: "warn" },
    { label: "Orphaned", value: c?.orphanedAnchors ?? 0, tone: "warn" },
  ];
}

export function DoneReviewingDialog({
  open,
  onOpenChange,
  counts,
  accessError,
  issueIdentifier,
  ownerName,
  canWakeOwner = true,
  submitting = false,
  onSubmit,
}: DoneReviewingDialogProps) {
  const [overall, setOverall] = useState("");
  const [commentOnLinkedIssue, setCommentOnLinkedIssue] = useState(true);
  const [wakeOwner, setWakeOwner] = useState(true);

  // Reset the form each time the dialog opens so a prior draft never leaks in.
  useEffect(() => {
    if (open) {
      setOverall("");
      setCommentOnLinkedIssue(true);
      setWakeOwner(canWakeOwner);
    }
  }, [open, canWakeOwner]);

  const stats = buildStats(counts);
  const hasUnresolved = stats.some((s) => s.value > 0);

  const submit = () => {
    void onSubmit({
      overallComment: overall.trim(),
      commentOnLinkedIssue,
      wakeOwner: wakeOwner && canWakeOwner,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" data-testid="done-reviewing-dialog">
        <DialogHeader>
          <DialogTitle>Done reviewing</DialogTitle>
          <DialogDescription>
            Hand the document back to its owner with an optional note. We'll notify them so they pick the review back up.
          </DialogDescription>
        </DialogHeader>

        {/* Review summary — suppressed when the counts couldn't be loaded, since
            zeros would falsely read as "nothing to hand off". */}
        {accessError ? (
          <p
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            data-testid="done-reviewing-access-error"
          >
            {accessError}
          </p>
        ) : (
        <div className="grid grid-cols-4 gap-2" data-testid="done-reviewing-summary">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-md border border-border bg-muted/30 px-2 py-1.5 text-center"
            >
              <div
                className={
                  stat.tone === "warn" && stat.value > 0
                    ? "text-lg font-semibold text-amber-600 dark:text-amber-400"
                    : "text-lg font-semibold text-foreground"
                }
                data-testid={`done-reviewing-count-${stat.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {stat.value}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
        )}
        {!accessError && !hasUnresolved ? (
          <p className="text-xs text-muted-foreground" data-testid="done-reviewing-clean">
            No open feedback — this is a clean handoff.
          </p>
        ) : null}

        {/* Optional overall comment */}
        <div className="space-y-1.5">
          <label htmlFor="done-reviewing-overall" className="text-xs font-medium text-foreground">
            Overall comment <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="done-reviewing-overall"
            data-testid="done-reviewing-overall"
            value={overall}
            onChange={(event) => setOverall(event.currentTarget.value)}
            placeholder="Summarize your review for the document owner…"
            rows={3}
            className="resize-none text-sm"
          />
        </div>

        {/* Notify toggles */}
        <div className="space-y-2.5 rounded-md border border-border p-3">
          <ToggleRow
            icon={<MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            title={issueIdentifier ? `Comment on ${issueIdentifier}` : "Comment on linked issue"}
            description="Post a review summary on the linked issue thread."
            checked={commentOnLinkedIssue}
            onCheckedChange={setCommentOnLinkedIssue}
            testId="done-reviewing-toggle-comment"
          />
          <ToggleRow
            icon={<Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
            title={ownerName ? `Wake ${ownerName}` : "Wake document owner"}
            description={
              canWakeOwner
                ? "Send a confirmation request so the owner picks the review back up."
                : "No owner is assigned to wake."
            }
            checked={wakeOwner && canWakeOwner}
            onCheckedChange={setWakeOwner}
            disabled={!canWakeOwner}
            testId="done-reviewing-toggle-wake"
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            title="Close this dialog without notifying the owner"
            data-testid="done-reviewing-just-close"
          >
            Just close
          </Button>
          <Button type="button" onClick={submit} disabled={submitting} data-testid="done-reviewing-submit">
            <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Done reviewing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ToggleRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  testId: string;
}

function ToggleRow({ icon, title, description, checked, onCheckedChange, disabled, testId }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        <div>
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="text-[11px] text-muted-foreground">{description}</div>
        </div>
      </div>
      <ToggleSwitch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} data-testid={testId} />
    </div>
  );
}
