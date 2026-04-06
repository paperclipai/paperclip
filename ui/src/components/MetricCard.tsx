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
    <div className={`h-full px-4 py-4 sm:px-5 sm:py-5 rounded-[2px] transition-colors hud-panel hud-shimmer${isClickable ? " hover:bg-[var(--sidebar-accent)] cursor-pointer" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-2xl sm:text-3xl font-bold font-[var(--font-mono)] tracking-tight tabular-nums text-[var(--primary)]">
            {value}
          </p>
          <p className="text-[10px] sm:text-[11px] font-semibold font-[var(--font-display)] uppercase tracking-[0.08em] text-muted-foreground mt-1.5">
            {label}
          </p>
          {description && (
            <div className="text-[10px] font-[var(--font-mono)] text-muted-foreground/70 mt-1.5 hidden sm:block">{description}</div>
          )}
        </div>
        <Icon className="h-4 w-4 text-[var(--primary)]/40 shrink-0 mt-1.5" />
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
