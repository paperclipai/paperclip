import { useState, type MouseEvent } from "react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { StatusIcon } from "../StatusIcon";

export function RemovableIssueReferencePill({
  issue,
  onRemove,
}: {
  issue: NonNullable<Issue["blockedBy"]>[number];
  onRemove: (issueId: string) => void;
}) {
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const issueLabel = issue.identifier ?? issue.title;
  const confirmLabel = issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title;
  const chipClassName = cn(
    "paperclip-mention-chip paperclip-mention-chip--issue",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
  );
  const content = (
    <>
      <StatusIcon status={issue.status} className="h-3 w-3 shrink-0" />
      <span className="truncate">{issueLabel}</span>
    </>
  );
  const removeLabel = `Remove ${issueLabel} as blocker`;
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsConfirmOpen(true);
  };
  const confirmRemove = () => {
    onRemove(issue.id);
    setIsConfirmOpen(false);
  };

  return (
    <>
      <span className="group relative inline-flex">
        <button
          type="button"
          className="absolute -right-1 -top-1 z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-colors transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-(length:--rad-2) focus-visible:ring-ring group-hover:opacity-100"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={handleRemove}
        >
          <X className="h-3 w-3" />
        </button>
        {issue.identifier ? (
          <Link
            to={`/issues/${issueLabel}`}
            data-mention-kind="issue"
            className={chipClassName}
            title={issue.title}
            aria-label={`Task ${issueLabel}: ${issue.title}`}
          >
            {content}
          </Link>
        ) : (
          <span
            data-mention-kind="issue"
            className={chipClassName}
            title={issue.title}
            aria-label={`Task: ${issue.title}`}
          >
            {content}
          </span>
        )}
      </span>
      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove blocker?</DialogTitle>
            <DialogDescription>
              Remove {confirmLabel} as a blocker for this task.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmRemove}>
              Remove blocker
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ExpandRelationListButton({
  hiddenCount,
  expanded,
  onClick,
}: {
  hiddenCount: number;
  expanded: boolean;
  onClick: () => void;
}) {
  if (!expanded && hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
      aria-label={expanded ? "Show fewer items" : `Show ${hiddenCount} more items`}
    >
      {expanded ? "Show less" : `Show ${hiddenCount} more`}
    </button>
  );
}
