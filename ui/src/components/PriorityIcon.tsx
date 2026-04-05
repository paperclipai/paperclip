import { useState } from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Popover, Button } from "@heroui/react";

const priorityConfig: Record<string, { icon: typeof ArrowUp; color: string; label: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault, label: "Critical" },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault, label: "High" },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault, label: "Medium" },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault, label: "Low" },
};

const allPriorities = ["critical", "high", "medium", "low"];

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  const [open, setOpen] = useState(false);
  const config = priorityConfig[priority] ?? priorityConfig.medium!;
  const Icon = config.icon;

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

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{config.label}</span></span> : icon;

  const triggerContent = showLabel ? (
    <span className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {icon}
      <span className="text-sm">{config.label}</span>
    </span>
  ) : icon;

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <button type="button" className="inline-flex items-center" onClick={(e) => e.stopPropagation()}>
          {triggerContent}
        </button>
      </Popover.Trigger>
      <Popover.Content placement="bottom start" className="w-36 p-1">
        {allPriorities.map((p) => {
          const c = priorityConfig[p]!;
          const PIcon = c.icon;
          return (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start gap-2 text-xs", p === priority && "bg-accent")}
              onPress={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PIcon className={cn("h-3.5 w-3.5", c.color)} />
              {c.label}
            </Button>
          );
        })}
      </Popover.Content>
    </Popover>
  );
}
