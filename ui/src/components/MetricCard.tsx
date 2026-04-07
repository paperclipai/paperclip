import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { ChevronRight } from "lucide-react";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
  accentColor?: "emerald" | "blue" | "amber" | "violet" | "red";
}

const ACCENT_BORDER: Record<string, string> = {
  emerald: "border-l-emerald-500",
  blue: "border-l-blue-500",
  amber: "border-l-amber-500",
  violet: "border-l-violet-500",
  red: "border-l-red-500",
};

const ACCENT_ICON: Record<string, string> = {
  emerald: "text-emerald-500/60",
  blue: "text-blue-500/60",
  amber: "text-amber-500/60",
  violet: "text-violet-500/60",
  red: "text-red-500/60",
};

export function MetricCard({ icon: Icon, value, label, description, to, onClick, accentColor }: MetricCardProps) {
  const isClickable = !!(to || onClick);
  const borderClass = accentColor ? `border-l-[3px] ${ACCENT_BORDER[accentColor]}` : "";
  const iconColor = accentColor ? ACCENT_ICON[accentColor] : "text-muted-foreground/50";

  const inner = (
    <div className={`relative h-full px-4 py-4 sm:px-5 sm:py-5 rounded-lg border border-border bg-card transition-all overflow-hidden ${borderClass}${isClickable ? " hover:-translate-y-0.5 hover:shadow-md cursor-pointer" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
            {label}
          </p>
          <p className="text-3xl sm:text-4xl font-bold tracking-tight [font-variant-numeric:tabular-nums] mt-1">
            {value}
          </p>
          {description && (
            <div className="text-sm text-muted-foreground/60 mt-1.5 hidden sm:block [font-variant-numeric:tabular-nums]">{description}</div>
          )}
        </div>
        <div className="flex flex-col items-center gap-2 shrink-0 mt-0.5">
          <div className="rounded-lg bg-muted/50 p-2">
            <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
          </div>
          {isClickable && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30" />}
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
