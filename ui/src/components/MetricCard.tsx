import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";

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
    <div className={`command-metric h-full rounded-[1.25rem] px-4 py-4 sm:px-5 sm:py-5 transition-all${isClickable ? " cursor-pointer hover:-translate-y-0.5 hover:bg-accent/55" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
            {value}
          </p>
          <p className="mt-1 text-xs sm:text-sm font-medium text-muted-foreground">
            {label}
          </p>
          {description && (
            <div className="mt-1.5 hidden text-xs text-muted-foreground/80 sm:block">{description}</div>
          )}
        </div>
        <div className="rounded-full border border-border bg-background/55 p-2">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
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
