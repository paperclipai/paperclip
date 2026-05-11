import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  chipLabel?: string;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({
  icon: Icon,
  value,
  label,
  description,
  chipLabel = "Board signal",
  to,
  onClick,
}: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div className={`brand-panel brand-kpi h-full rounded-[1.5rem] px-4 py-4 sm:px-5 sm:py-5 transition-all${isClickable ? " cursor-pointer hover:-translate-y-0.5 hover:brightness-105" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="brand-chip mb-3 inline-flex rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
            {chipLabel}
          </div>
          <p className="text-3xl sm:text-4xl font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="mt-1 text-xs sm:text-sm font-medium text-muted-foreground">
            {label}
          </p>
          {description && (
            <div className="mt-2 hidden text-xs text-muted-foreground/80 sm:block">{description}</div>
          )}
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/[0.12] text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full" onClick={onClick}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <div className="h-full" onClick={onClick}>
        {inner}
      </div>
    );
  }

  return inner;
}
