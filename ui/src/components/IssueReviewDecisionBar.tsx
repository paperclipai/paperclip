import { useState } from "react";
import { Check, MessageSquareWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

interface IssueReviewDecisionBarProps {
  pending?: boolean;
  pendingDecisionTitle?: string | null;
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
}

export function IssueReviewDecisionBar({
  pending = false,
  pendingDecisionTitle,
  onApprove,
  onRequestChanges,
}: IssueReviewDecisionBarProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const trimmedFeedback = feedback.trim();

  return (
    <>
      <section
        aria-label="Review decision"
        className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 sm:flex sm:items-center sm:justify-between sm:gap-4"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold text-violet-800 dark:text-violet-200">
            {pendingDecisionTitle ? "Decision required" : "Ready for your review"}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {pendingDecisionTitle
              ? `Respond to “${pendingDecisionTitle}” in the task thread below before completing this task.`
              : "Check the work product below, then approve it or return it with specific feedback."}
          </p>
        </div>
        {!pendingDecisionTitle ? (
          <div className="mt-3 flex shrink-0 flex-wrap gap-2 sm:mt-0">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => setDialogOpen(true)}
          >
            <MessageSquareWarning className="mr-1.5 h-4 w-4" />
            Request changes
          </Button>
          <Button size="sm" disabled={pending} onClick={onApprove}>
            <Check className="mr-1.5 h-4 w-4" />
            Approve &amp; complete
          </Button>
          </div>
        ) : null}
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>
              The task will return to To do and the assignee will receive this feedback.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            autoFocus
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Describe what needs to change…"
            rows={5}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={pending || !trimmedFeedback}
              onClick={() => {
                onRequestChanges(trimmedFeedback);
                setDialogOpen(false);
                setFeedback("");
              }}
            >
              Return to assignee
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
