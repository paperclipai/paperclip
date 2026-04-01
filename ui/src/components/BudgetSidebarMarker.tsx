import { DollarSign } from "lucide-react";
import { useTranslation } from "react-i18next";

export function BudgetSidebarMarker({ title }: { title?: string }) {
  const { t } = useTranslation(["costs"]);
  const label = title ?? t("costs:budgetPolicy.pausedByBudget");
  return (
    <span
      title={label}
      aria-label={label}
      className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
    >
      <DollarSign className="h-3 w-3" />
    </span>
  );
}
