import { useState } from "react";
import { Link2 } from "lucide-react";
import { cn } from "../lib/utils";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
  /**
   * When status === "blocked" and this is > 0, renders a distinct
   * "blocked by dependencies" indicator instead of the manual-blocked one.
   */
  unresolvedBlockerCount?: number;
}

export function StatusIcon({ status, onChange, className, showLabel, unresolvedBlockerCount }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const isDependencyBlocked = status === "blocked" && (unresolvedBlockerCount ?? 0) > 0;
  const colorClass = isDependencyBlocked
    ? "text-muted-foreground"
    : (issueStatusIcon[status] ?? issueStatusIconDefault);
  const isDone = status === "done";

  const dependencyBlockedTitle = isDependencyBlocked
    ? `Blocked by ${unresolvedBlockerCount} unresolved ${unresolvedBlockerCount === 1 ? "dependency" : "dependencies"} — will auto-unblock when resolved`
    : undefined;

  const indicator = isDependencyBlocked ? (
    <span
      className="inline-flex shrink-0"
      aria-label="Blocked by dependencies"
      title={dependencyBlockedTitle}
    >
      <Link2
        className={cn("h-4 w-4", colorClass, onChange && !showLabel && "cursor-pointer", className)}
      />
    </span>
  ) : (
    <span
      className={cn(
        "relative inline-flex h-4 w-4 rounded-full border-2 shrink-0",
        colorClass,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
      title={status === "blocked" ? "Blocked — needs attention" : undefined}
    >
      {isDone && (
        <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
      )}
    </span>
  );

  const displayLabel = isDependencyBlocked ? "Blocked by deps" : statusLabel(status);

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5" title={dependencyBlockedTitle}>
        {indicator}
        <span className="text-sm">{displayLabel}</span>
      </span>
    ) : indicator;
  }

  const trigger = showLabel ? (
    <button
      className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
      title={dependencyBlockedTitle}
    >
      {indicator}
      <span className="text-sm">{displayLabel}</span>
    </button>
  ) : indicator;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {allStatuses.map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
            onClick={() => {
              onChange(s);
              setOpen(false);
            }}
          >
            <StatusIcon status={s} />
            {statusLabel(s)}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
