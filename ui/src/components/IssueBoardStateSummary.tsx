import type { Issue } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { getIssueBoardStateTone } from "../lib/issue-board-state-presentation";

export function IssueBoardStateSummary({
  issue,
  className,
}: {
  issue: Issue;
  className?: string;
}) {
  const boardState = issue.boardState;
  if (!boardState) return null;

  const tone = getIssueBoardStateTone(boardState.kind);

  return (
    <span
      data-testid="issue-board-state-summary"
      className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs font-medium", tone.summaryClassName, className)}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dotClassName)} aria-hidden="true" />
      <span className="truncate">{boardState.headline}</span>
    </span>
  );
}
