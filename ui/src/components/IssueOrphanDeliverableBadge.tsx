import { FileWarning } from "lucide-react";
import type { IssueOrphanDeliverableSignal } from "@paperclipai/shared";
import { cn, relativeTime } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const STATUS_VERB: Record<IssueOrphanDeliverableSignal["status"], string> = {
  in_progress: "started",
  in_review: "moved to review",
  done: "marked done",
};

export function IssueOrphanDeliverableBadge({
  signal,
  className,
  hideLabel = false,
}: {
  signal: IssueOrphanDeliverableSignal;
  className?: string;
  hideLabel?: boolean;
}) {
  const flaggedSinceDate = signal.flaggedSince instanceof Date
    ? signal.flaggedSince
    : new Date(signal.flaggedSince);
  const verb = STATUS_VERB[signal.status];
  const relative = relativeTime(flaggedSinceDate);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300 shrink-0",
            className,
          )}
          aria-label="No deliverable artifact attached"
          data-testid="issue-orphan-deliverable-badge"
        >
          <FileWarning className="h-3 w-3" aria-hidden />
          {hideLabel ? null : <span>No deliverable</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div className="max-w-xs space-y-1 text-xs">
          <div className="font-semibold">No deliverable artifact attached</div>
          <div className="text-muted-foreground">
            This issue was {verb} {relative}, but has no documents and no agent-authored comments.
            Agents should save the artifact (document or summary comment) before flipping status.
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
