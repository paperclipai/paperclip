import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { Card } from "./ui/card";

interface MetricCardProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  to?: string;
  onClick?: () => void;
  /** Use the shared bordered Card surface instead of an unframed metric. */
  appearance?: "plain" | "card";
}

export function MetricCard({ icon: Icon, value, label, description, to, onClick, appearance = "plain" }: MetricCardProps) {
  const isClickable = !!(to || onClick);

  const content = (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <p className={`text-2xl sm:text-3xl font-semibold tracking-tight tabular-nums${appearance === "card" ? " text-foreground" : ""}`}>
          {value}
        </p>
        <p className="text-xs sm:text-sm font-medium text-muted-foreground mt-1">
          {label}
        </p>
        {description && (
          <div className="text-xs text-muted-foreground/70 mt-1.5 hidden sm:block">{description}</div>
        )}
      </div>
      <Icon className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-1.5" />
    </div>
  );
  const surfaceClassName = `h-full px-4 py-4 sm:px-5 sm:py-5 rounded-lg transition-colors${isClickable ? " hover:bg-accent/50 cursor-pointer" : ""}`;
  const inner = appearance === "card"
    ? <Card elevation="low" className={surfaceClassName}>{content}</Card>
    : <div className={surfaceClassName}>{content}</div>;

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
