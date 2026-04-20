import { useTranslation } from "react-i18next";
import { DollarSign } from "lucide-react";

export function BudgetSidebarMarker({ title }: { title?: string }) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t("budgetSidebarMarker.pausedByBudget", { defaultValue: "Paused by budget" });
  return (
    <span
      title={resolvedTitle}
      aria-label={resolvedTitle}
      className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
