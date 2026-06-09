import { DollarSign } from "lucide-react";

export type BudgetSidebarMarkerLevel = "healthy" | "warning" | "critical";

const levelClasses: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: "bg-status-success/15 text-status-success",
  warning: "bg-status-warning/15 text-status-warning",
  critical: "bg-status-error/15 text-status-error",
};

const defaultTitles: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: "Budget healthy",
  warning: "Budget warning",
  critical: "Paused by budget",
};

export function BudgetSidebarMarker({
  title,
  level = "critical",
}: {
  title?: string;
  level?: BudgetSidebarMarkerLevel;
}) {
  const accessibleTitle = title ?? defaultTitles[level];

  return (
    <span
      title={accessibleTitle}
      aria-label={accessibleTitle}
      className={`ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-current/25 ${levelClasses[level]}`}
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
