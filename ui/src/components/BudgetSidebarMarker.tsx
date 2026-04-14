import { DollarSign } from "lucide-react";
import { useI18n } from "../context/I18nContext";

export function BudgetSidebarMarker({ title = "Paused by budget" }: { title?: string }) {
  const { t } = useI18n();
  const resolvedTitle = title === "Paused by budget" ? t("nav.budget_paused") : title;
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
