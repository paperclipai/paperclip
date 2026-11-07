import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const priorityConfig: Record<string, { icon: typeof ArrowUp; color: string; label: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault, get label() { return t("task-components:critical_427dd296"); } },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault, get label() { return t("task-components:high_c4ebc6d4"); } },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault, get label() { return t("task-components:medium_8e588cd1"); } },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault, get label() { return t("task-components:low_f793de20"); } },
};

const allPriorities = ["critical", "high", "medium", "low"];

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  useTranslation("task-components");
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

  const trigger = showLabel ? (
    <button
      type="button"
      aria-label={t("task-components:changePriorityCurrent_a90425d7", { value1: config.label })}
      className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
    >
      {icon}
      <span className="text-sm">{config.label}</span>
    </button>
  ) : (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={t("task-components:changePriorityCurrent_a90425d7", { value1: config.label })}
      className="inline-flex cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
    >
      {icon}
    </button>
  );

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
              {c.label}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
