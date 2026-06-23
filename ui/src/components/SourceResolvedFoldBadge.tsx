import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

export interface SourceResolvedFoldBadgeProps {
  className?: string;
  title?: string;
  /** When true (default) the leading sparkles icon is rendered. */
  showIcon?: boolean;
}

export function SourceResolvedFoldBadge({
  className,
  title,
  showIcon = true,
}: SourceResolvedFoldBadgeProps) {
  const { t } = useTranslation();
  const resolvedTitle =
    title ??
    t("components.sourceResolvedFoldBadge.title", {
      defaultValue: "System folded this run as a source-resolved false positive.",
    });
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        "border-emerald-300/60 bg-emerald-50/80 text-emerald-900",
        "dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
        className,
      )}
      title={resolvedTitle}
      aria-label={t("components.sourceResolvedFoldBadge.ariaLabel", {
        defaultValue: "Source-resolved watchdog fold",
      })}
    >
      {showIcon ? <Sparkles className="h-3 w-3 text-emerald-700 dark:text-emerald-300" aria-hidden /> : null}
      {t("components.sourceResolvedFoldBadge.label", { defaultValue: "Source-resolved" })}
    </span>
  );
}

export default SourceResolvedFoldBadge;
