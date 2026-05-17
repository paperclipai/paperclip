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
      ? "stroke-red-500"
      : tone === "success"
        ? "stroke-emerald-500"
        : tone === "info"
          ? "stroke-[#2C94EE]"
          : "stroke-foreground";
  const valueClass =
    tone === "danger"
      ? "text-red-500"
      : "text-foreground";

  const inner = (
    <div
      className={cn(
        "h-full px-3 py-5 sm:px-4 sm:py-6 rounded-2xl border border-border/60 bg-background/40 transition-colors flex flex-col items-center gap-3",
        isClickable && "hover:bg-accent/40 cursor-pointer",
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
            className="stroke-muted-foreground/50"
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
          <DotMatrixText className={cn("text-3xl leading-none sm:text-4xl", valueClass)}>
            {value}
          </DotMatrixText>
        </div>
      </div>
      <div className="text-center min-w-0 w-full">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground truncate">{label}</p>
        {description && (
          <div className="text-[11px] text-muted-foreground/70 mt-1.5 hidden sm:block">
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
