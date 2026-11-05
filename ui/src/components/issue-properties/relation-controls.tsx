import { t, useTranslation, Trans } from "@/i18n";
import { useState, type MouseEvent } from "react";
import type { Issue, IssueLockedStub } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { LockedIssueChip, isLockedIssueStub } from "../LockedIssueChip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowUpRight, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { StatusIcon } from "../StatusIcon";

export function RemovableIssueReferencePill({
  issue,
  onRemove,
  isMobile = false,
}: {
  issue: NonNullable<Issue["blockedBy"]>[number] | IssueLockedStub;
  onRemove: (issueId: string) => void;
  isMobile?: boolean;
}) {
  useTranslation("task-components");
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const locked = isLockedIssueStub(issue);
  const issueLabel = locked
    ? issue.identifier ?? t("task-components:privateTask_8d52cb21")
    : issue.identifier ?? issue.title;
  const confirmLabel = locked
    ? issue.identifier ?? t("final-components-a:thisPrivateTask_f272465f")
    : issue.identifier
      ? `${issue.identifier}: ${issue.title}`
      : issue.title;
  const chipClassName = cn(
    "paperclip-mention-chip paperclip-mention-chip--issue",
    "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    !locked && issue.identifier && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
  );
  // A private blocker referenced from a task you *can* see: show the locked chip
  // (never a title/link) but keep the detach affordance so you aren't stuck
  // blocked by something invisible.
  const content = locked ? (
    <LockedIssueChip identifier={issue.identifier} />
  ) : (
    <>
      <StatusIcon status={issue.status} displayStatus={issue.displayStatus} className="h-3 w-3 shrink-0" />
      <span className="truncate">{issueLabel}</span>
    </>
  );
  const removeLabel = t("task-components:removeAsBlocker_9a08c339", { value1: issueLabel });
  const openRemoveConfirmation = () => setIsConfirmOpen(true);
  const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openRemoveConfirmation();
  };
  const confirmRemove = () => {
    onRemove(issue.id);
    setIsConfirmOpen(false);
  };

  return (
    <>
      <span className="group relative inline-flex">
        {isMobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-mention-kind="issue"
                className={chipClassName}
                title={locked ? t("task-components:privateTask_8d52cb21") : issue.title}
                aria-label={t("task-components:actionsForBlocker_9f8c0539", { value1: issueLabel })}
              >
                {content}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {!locked && issue.identifier ? (
                <DropdownMenuItem asChild>
                  <Link to={`/issues/${issue.identifier}`}>
                    <ArrowUpRight className="h-4 w-4" />{t("task-components:visitTask_ecacc67b")}</Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={openRemoveConfirmation}>
                <X className="h-4 w-4" />{t("task-components:removeBlocker_76792aa6")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            <button
              type="button"
              className="absolute -right-1 -top-1 z-10 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-colors transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-(length:--rad-2) focus-visible:ring-ring group-hover:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={handleRemove}
            >
              <X className="h-3 w-3" />
            </button>
            {locked ? (
              content
            ) : issue.identifier ? (
              <Link
                to={`/issues/${issue.identifier}`}
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={t("task-components:task_11ac34f3", { value1: issueLabel, value2: issue.title })}
              >
                {content}
              </Link>
            ) : (
              <span
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={t("task-components:task_9b8def10", { value1: issue.title })}
              >
                {content}
              </span>
            )}
          </>
        )}
      </span>
      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("task-components:removeBlocker_b7d963b0")}</DialogTitle>
            <DialogDescription><Trans ns="task-components" i18nKey="sentence_9a7328ea74d3" components={{ part1: <>{confirmLabel}</> }} /></DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("task-components:cancel_19766ed6")}</Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmRemove}>{t("task-components:removeBlocker_76792aa6")}</Button>
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
  useTranslation("task-components");
  if (!expanded && hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
      aria-label={expanded ? t("task-components:showFewerItems_b908f492") : t("task-components:showMoreItems_9c9b6c95", { value1: hiddenCount })}
    >
      {expanded ? t("task-components:showLess_94ea9b1d") : t("task-components:showMore_398301a5", { value1: hiddenCount })}
    </button>
  );
}
