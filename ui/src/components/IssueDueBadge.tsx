import { Calendar } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import {
  formatIssueDueDate,
  formatIssueDueDateShort,
  getIssueDueState,
} from "../lib/issue-due-date";

export function IssueDueBadge({
  issue,
  compact = false,
}: {
  issue: Pick<Issue, "dueDate" | "status">;
  compact?: boolean;
}) {
  if (!issue.dueDate) return null;

  const dueState = getIssueDueState(issue.dueDate, issue.status);
  const label =
    dueState === "overdue"
      ? `Overdue ${formatIssueDueDateShort(issue.dueDate)}`
      : dueState === "today"
        ? "Due today"
        : compact
          ? formatIssueDueDateShort(issue.dueDate)
          : formatIssueDueDate(issue.dueDate);

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        dueState === "overdue" && "border-destructive/50 bg-destructive/10 text-destructive",
        dueState === "today" && "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        dueState === "upcoming" && "border-border bg-muted/40 text-muted-foreground",
        dueState === "neutral" && "border-border bg-transparent text-muted-foreground",
      )}
      title={`Due ${formatIssueDueDate(issue.dueDate)}`}
      aria-label={`Due ${formatIssueDueDate(issue.dueDate)}`}
    >
      <Calendar className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
