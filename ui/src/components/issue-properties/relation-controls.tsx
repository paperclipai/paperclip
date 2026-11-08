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
import { useTranslation } from "@/i18n";
import { cn } from "../../lib/utils";
import { StatusIcon } from "../StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";

export function RemovableIssueReferencePill({
  issue,
  onRemove,
  isMobile = false,
}: {
  issue: NonNullable<Issue["blockedBy"]>[number] | IssueLockedStub;
  onRemove: (issueId: string) => void;
  isMobile?: boolean;
}) {
  const { t } = useTranslation();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const locked = isLockedIssueStub(issue);
  const issueLabel = locked
    ? issue.identifier ?? t("issues.RemovableIssueReferencePill.privateTask")
    : issue.identifier ?? issue.title;
  const confirmLabel = locked
    ? issue.identifier ?? t("issues.RemovableIssueReferencePill.thisPrivateTask")
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
      <StatusIcon {...taskStatusIconProps(issue)} className="h-3 w-3 shrink-0" />
      <span className="truncate">{issueLabel}</span>
    </>
  );
  const removeLabel = t("issues.RemovableIssueReferencePill.removeBlockerLabel", { label: issueLabel });
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
                title={locked ? t("issues.RemovableIssueReferencePill.privateTask") : issue.title}
                aria-label={t("issues.RemovableIssueReferencePill.actionsFor", { label: issueLabel })}
              >
                {content}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {!locked && issue.identifier ? (
                <DropdownMenuItem asChild>
                  <Link to={`/issues/${issue.identifier}`}>
                    <ArrowUpRight className="h-4 w-4" />
                    {t("issues.RemovableIssueReferencePill.visitTask")}
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={openRemoveConfirmation}>
                <X className="h-4 w-4" />
                {t("issues.RemovableIssueReferencePill.removeBlocker")}
              </DropdownMenuItem>
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
                aria-label={t("issues.RemovableIssueReferencePill.taskAria", { label: issueLabel, title: issue.title })}
              >
                {content}
              </Link>
            ) : (
              <span
                data-mention-kind="issue"
                className={chipClassName}
                title={issue.title}
                aria-label={t("issues.RemovableIssueReferencePill.taskTitleAria", { title: issue.title })}
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
            <DialogTitle>{t("issues.RemovableIssueReferencePill.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("issues.RemovableIssueReferencePill.confirmDescription", { label: confirmLabel })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">{t("issues.RemovableIssueReferencePill.cancel")}</Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={confirmRemove}>
              {t("issues.RemovableIssueReferencePill.removeBlocker")}
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
  const { t } = useTranslation();
  if (!expanded && hiddenCount <= 0) return null;
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
      aria-label={expanded ? t("issues.ExpandRelationListButton.showFewerItems") : t("issues.ExpandRelationListButton.showMoreItems", { hidden: hiddenCount })}
    >
      {expanded ? t("issues.ExpandRelationListButton.showLess") : t("issues.ExpandRelationListButton.showMore", { hidden: hiddenCount })}
    </button>
  );
}
