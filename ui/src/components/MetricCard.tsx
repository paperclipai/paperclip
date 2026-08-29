import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { DotMatrixText } from "./NothingAesthetic";
import { cn } from "../lib/utils";

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
    <div
      className={cn(
        "dashboard-metric-card dashboard-surface dashboard-surface-dotted relative h-full overflow-hidden rounded-md border px-4 py-4 sm:px-5 sm:py-5",
        isClickable && "dashboard-surface-interactive cursor-pointer",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <DotMatrixText className="dashboard-display-value block text-3xl leading-none sm:text-4xl">
            {value}
          </DotMatrixText>
          <p className="dashboard-eyebrow mt-2 sm:text-xs">
            {label}
          </p>
          {description && (
            <div className="dashboard-supporting-text mt-1.5 hidden sm:block">{description}</div>
          )}
        </div>
        <span className="dashboard-icon-box mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border">
          <Icon className="h-4 w-4 text-muted-foreground/65" />
        </span>
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
