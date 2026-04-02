import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { issueStatusIcon, issueStatusIconDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

interface StatusIconProps {
  status: string;
  onChange?: (status: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function StatusIcon({ status, onChange, className, showLabel }: StatusIconProps) {
  const { t } = useTranslation(["issues"]);
  const [open, setOpen] = useState(false);
  const statusLabel = (s: string): string => {
    const key = `issues:statuses.${s}` as const;
    const translated = t(key, "");
    return translated || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };
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

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {circle}
      <span className="text-sm">{statusLabel(status)}</span>
    </button>
  ) : circle;

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
