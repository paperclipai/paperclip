import { DollarSign } from "lucide-react";
import { t } from "@/i18n";

export type BudgetSidebarMarkerLevel = "healthy" | "warning" | "critical";

const levelClasses: Record<BudgetSidebarMarkerLevel, string> = {
  healthy: "bg-emerald-500/90 text-white",
  warning: "bg-amber-500/95 text-amber-950",
  critical: "bg-red-500/90 text-white",
};

const getDefaultTitles = (): Record<BudgetSidebarMarkerLevel, string> => ({
  healthy: t("components.budgetSidebarMarker.healthy", {
    defaultValue: "Budget healthy",
  }),
  warning: t("components.budgetSidebarMarker.warning", {
    defaultValue: "Budget warning",
  }),
  critical: t("components.budgetSidebarMarker.critical", {
    defaultValue: "Paused by budget",
  }),
});

export function BudgetSidebarMarker({
  title,
  level = "critical",
}: {
  title?: string;
  level?: BudgetSidebarMarkerLevel;
}) {
  const accessibleTitle = title ?? getDefaultTitles()[level];

  return (
    <span
      title={accessibleTitle}
      aria-label={accessibleTitle}
      className={`ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.08)] ${levelClasses[level]}`}
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
