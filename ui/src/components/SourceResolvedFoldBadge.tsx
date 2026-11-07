import { t, useTranslation } from "@/i18n";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SourceResolvedFoldBadgeProps {
  className?: string;
  title?: string;
  /** When true (default) the leading sparkles icon is rendered. */
  showIcon?: boolean;
}

export function SourceResolvedFoldBadge({
  className,
  title = t("final-components-b:SourceResolvedFoldBadge.System_folded_this_run_as_a_source_resolved_false_positive_1643b5"),
  showIcon = true,
}: SourceResolvedFoldBadgeProps) {
  useTranslation("task-components");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-(length:--text-micro) font-medium",
        "border-emerald-300/60 bg-emerald-50/80 text-emerald-900",
        "dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
        className,
      )}
      title={title}
      aria-label={t("task-components:sourceResolvedWatchdogFold_b1780fd4")}
    >
      {showIcon ? <Sparkles className="h-3 w-3 text-emerald-700 dark:text-emerald-300" aria-hidden /> : null}{t("task-components:sourceResolved_ef82f9cf")}</span>
  );
}

export default SourceResolvedFoldBadge;
