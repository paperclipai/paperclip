import { t, useTranslation } from "@/i18n";
import { DollarSign } from "lucide-react";

export type BudgetSidebarMarkerLevel = "healthy" | "warning" | "critical";

const levelClasses: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: "bg-emerald-500/90 text-white",
  warning: "bg-amber-500/95 text-amber-950",
  critical: "bg-red-500/90 text-white",
};

const defaultTitles: Record<BudgetSidebarMarkerLevel, string> = {
  get healthy() { return t("final-components-b:BudgetSidebarMarker.Budget_healthy_430819"); },
  get warning() { return t("final-components-b:BudgetSidebarMarker.Budget_warning_5e68cb"); },
  get critical() { return t("final-components-b:BudgetSidebarMarker.Paused_by_budget_96976b"); },
};

export function BudgetSidebarMarker({
  title,
  level = "critical",
}: {
  title?: string;
  level?: BudgetSidebarMarkerLevel;
}) {
  useTranslation("final-components-b");
  const accessibleTitle = title ?? defaultTitles[level];

  return (
    <span
      title={accessibleTitle}
      aria-label={accessibleTitle}
      className={`ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full shadow-(--shadow-extract-3) ${levelClasses[level]}`}
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
