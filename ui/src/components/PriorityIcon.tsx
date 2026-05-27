import { useState } from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useLocalizedCopy } from "@/i18n/ui-copy";

const priorityConfig: Record<string, { icon: typeof ArrowUp; color: string; label: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault, label: "Critical" },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault, label: "High" },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault, label: "Medium" },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault, label: "Low" },
};

const allPriorities = ["critical", "high", "medium", "low"];

function priorityLabel(priority: string, copy: ReturnType<typeof useLocalizedCopy>) {
  switch (priority) {
    case "critical":
      return copy("priority.critical", "Critical", "긴급");
    case "high":
      return copy("priority.high", "High", "높음");
    case "medium":
      return copy("priority.medium", "Medium", "보통");
    case "low":
      return copy("priority.low", "Low", "낮음");
    default:
      return priority.replace(/_/g, " ");
  }
}

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  const copy = useLocalizedCopy();
  const [open, setOpen] = useState(false);
  const config = priorityConfig[priority] ?? priorityConfig.medium!;
  const Icon = config.icon;
  const label = priorityLabel(priority, copy);

  const icon = (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        config.color,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{label}</span></span> : icon;

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  ) : icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        {allPriorities.map((p) => {
          const c = priorityConfig[p]!;
          const PIcon = c.icon;
          return (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start gap-2 text-xs", p === priority && "bg-accent")}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PIcon className={cn("h-3.5 w-3.5", c.color)} />
              {priorityLabel(p, copy)}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
