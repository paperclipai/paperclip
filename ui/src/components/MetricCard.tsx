import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const inner = (
    <div className={cn(
      "h-full rounded-xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5 shadow-sm transition-colors",
      isClickable && "hover:bg-accent/50 cursor-pointer",
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-3xl sm:text-4xl font-bold tracking-tight tabular-nums font-mono">
            {value}
          </p>
          <p className="text-[11px] sm:text-xs font-medium text-muted-foreground mt-1.5 uppercase tracking-wider">
            {label}
          </p>
          {description && (
            <div className="text-[10px] text-muted-foreground/60 mt-1.5 font-mono">{description}</div>
          )}
        </div>
        <div className="shrink-0 p-2">
          <Icon className="h-4 w-4 text-muted-foreground/40" />
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
