import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { DotMatrixText } from "./NothingAesthetic";

interface CircularStatWidgetProps {
  icon: LucideIcon;
  value: string | number;
  label: string;
  description?: ReactNode;
  /** Arc fill, 0..1 — clamped. Defaults to 0 (empty ring). */
  percent?: number;
  tone?: "default" | "danger" | "success" | "info";
  to?: string;
  onClick?: () => void;
}

const SIZE = 140;
const STROKE = 6;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;

export function CircularStatWidget({
  icon: Icon,
  value,
  label,
  description,
  percent = 0,
  tone = "default",
  to,
  onClick,
}: CircularStatWidgetProps) {
  const clamped = Math.max(0, Math.min(1, percent));
  const dashOffset = CIRC * (1 - clamped);
  const isClickable = !!(to || onClick);

  const arcClass =
    tone === "danger"
      ? "dashboard-stat-arc-danger"
      : tone === "success"
        ? "dashboard-stat-arc-success"
        : tone === "info"
          ? "dashboard-stat-arc-info"
          : "dashboard-stat-arc-default";
  const valueClass =
    tone === "danger"
      ? "dashboard-stat-value-danger"
      : tone === "success"
        ? "dashboard-stat-value-success"
        : tone === "info"
          ? "dashboard-stat-value-info"
          : "dashboard-stat-value-default";

  const inner = (
    <div
      className={cn(
        "dashboard-stat-widget h-full px-3 py-5 sm:px-4 sm:py-6 rounded-2xl border flex flex-col items-center gap-3",
        isClickable && "dashboard-surface-interactive cursor-pointer",
      )}
    >
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="-rotate-90"
          aria-hidden="true"
        >
          {/* Dashed background track — Nothing-Phone LED-ring feel, chunky pixelated dots */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={4}
            strokeDasharray="3 10"
            strokeLinecap="round"
            className="dashboard-stat-track"
          />
          {/* Filled arc */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={CIRC}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            className={cn("transition-[stroke-dashoffset] duration-700 ease-out", arcClass)}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
          <DotMatrixText className={cn("dashboard-display-value text-3xl leading-none sm:text-4xl", valueClass)}>
            {value}
          </DotMatrixText>
        </div>
      </div>
      <div className="text-center min-w-0 w-full">
        <p className="dashboard-eyebrow truncate">{label}</p>
        {description && (
          <div className="dashboard-supporting-text mt-1.5 hidden sm:block">
            {description}
          </div>
        )}
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="no-underline text-inherit h-full block" onClick={onClick}>
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
