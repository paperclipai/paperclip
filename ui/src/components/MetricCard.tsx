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
    <div className={`paperclip-monitor-card-strong relative h-full overflow-hidden p-4 sm:p-5${isClickable ? " cursor-pointer" : ""}`}>
      <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_68%)]" />
      <div className="relative flex h-full flex-col justify-between gap-5">
        <div className="flex items-start justify-between gap-3">
          <div className="paperclip-chip flex h-10 w-10 items-center justify-center rounded-[calc(var(--radius)-0.15rem)]">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          {isClickable && <span className="paperclip-nav-meta text-primary">Open</span>}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            {value}
          </p>
          <p className="paperclip-monitor-title mt-2">
            {label}
          </p>
          {description && (
            <div className="paperclip-monitor-subtitle mt-3 hidden text-xs leading-5 sm:block">{description}</div>
          )}
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
