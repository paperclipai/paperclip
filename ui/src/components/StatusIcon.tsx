import { useState } from "react";
import { cn } from "../lib/utils";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { Popover, Button } from "@heroui/react";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function StatusIcon({ status, onChange, className, showLabel }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const colorClass = issueStatusIcon[status] ?? issueStatusIconDefault;
  const isDone = status === "done";

  const circle = (
    <span
      className={cn(
        "relative inline-flex h-4 w-4 rounded-full border-2 shrink-0",
        colorClass,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      {isDone && (
        <span className="absolute inset-0 m-auto h-2 w-2 rounded-full bg-current" />
      )}
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{circle}<span className="text-sm">{statusLabel(status)}</span></span> : circle;

  const triggerContent = showLabel ? (
    <span className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {circle}
      <span className="text-sm">{statusLabel(status)}</span>
    </span>
  ) : circle;

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <button type="button" className="inline-flex items-center" onClick={(e) => e.stopPropagation()}>
          {triggerContent}
        </button>
      </Popover.Trigger>
      <Popover.Content placement="bottom start" className="w-40 p-1">
        {allStatuses.map((s) => (
          <Button
            key={s}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
            onPress={() => {
              onChange(s);
              setOpen(false);
            }}
          >
            <StatusIcon status={s} />
            {statusLabel(s)}
          </Button>
        ))}
      </Popover.Content>
    </Popover>
  );
}
