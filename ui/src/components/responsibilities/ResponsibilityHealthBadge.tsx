import type { CSSProperties } from "react";
import type { ResponsibilityHealth } from "@paperclipai/shared";
import { Clock } from "lucide-react";
import { RESPONSIBILITY_HEALTH_LABEL, RESPONSIBILITY_HEALTH_STATUS_VAR } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";

/** Points the shared `.status-chip` / `.status-fill` recipes at a status hue. */
export function healthStatusStyle(health: ResponsibilityHealth): CSSProperties {
  return { "--sc": `var(${RESPONSIBILITY_HEALTH_STATUS_VAR[health]})` } as CSSProperties;
}

/**
 * A responsibility's status chip: behind, at risk, on track or not measured.
 * Uses the same bordered status-chip recipe as agent and task status chips.
 */
// design-allow(pill-pattern): status chips keep the shared .status-chip color-mix mechanic (DECISION-SHEET.md C8).
export function ResponsibilityHealthBadge({
  health,
  overridden = false,
  label,
  className,
}: {
  health: ResponsibilityHealth;
  /** The owner set this status by hand. */
  overridden?: boolean;
  /** Other words on the same hue (an agent's "Can't tell yet"). */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "status-chip inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={healthStatusStyle(health)}
      title={overridden ? "Set by hand" : undefined}
    >
      {label ?? RESPONSIBILITY_HEALTH_LABEL[health]}
      {overridden ? <span className="sr-only"> (set by hand)</span> : null}
    </span>
  );
}

/** The stale-number flag: the reading has not been updated in a while. */
export function StaleFlag({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-(--status-task-icon-todo)", className)}>
      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
