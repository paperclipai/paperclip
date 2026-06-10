import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  descriptionText?: string;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, descriptionText, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);
  const accessibleLabel = descriptionText
    ? `${label}: ${value}. ${descriptionText}`
    : `${label}: ${value}`;

  const inner = (
    <div className={`h-full px-4 py-4 sm:px-5 sm:py-5 rounded-lg transition-colors${isClickable ? " hover:bg-accent/50 cursor-pointer" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
            {label}
          </p>
          {description && (
            <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground/75 sm:text-xs">
              {description}
            </div>
          )}
        </div>
        <Icon className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" aria-hidden />
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick} aria-label={accessibleLabel}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        className="h-full w-full appearance-none bg-transparent p-0 text-left text-inherit"
        onClick={onClick}
        aria-label={accessibleLabel}
      >
        {inner}
      </button>
    );
  }

  return inner;
}
