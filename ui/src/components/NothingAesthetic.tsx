import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/utils";

type GlyphTone = "default" | "muted" | "success" | "warning" | "danger" | "live";

const toneClasses: Record<GlyphTone, string> = {
  default: "text-current",
  muted: "text-muted-foreground",
  success: "text-current",
  warning: "text-amber-500",
  danger: "text-red-500",
  live: "text-current",
};

export function DotMatrixText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-display tabular-nums tracking-[0.08em]", className)}>
      {children}
    </span>
  );
}

export function GlyphRing({
  tone = "default",
  active = false,
  complete = false,
  broken = false,
  className,
}: {
  tone?: GlyphTone;
  active?: boolean;
  complete?: boolean;
  broken?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
        toneClasses[tone],
        className,
      )}
      aria-hidden="true"
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full border border-dashed border-current/55",
          active && "motion-safe:animate-[glyph-pulse_1.8s_ease-in-out_infinite]",
          broken && "border-red-500/80",
        )}
      />
      <span className="absolute inset-[4px] rounded-full border border-dotted border-current/35" />
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current/80",
          complete && "h-2.5 w-2.5",
          broken && "bg-red-500",
        )}
      />
      {broken ? <span className="absolute h-px w-4 rotate-45 bg-red-500" /> : null}
    </span>
  );
}

export function LedProgress({
  percent,
  tone = "default",
  showDeficitNotch = false,
  className,
}: {
  percent: number;
  tone?: GlyphTone;
  showDeficitNotch?: boolean;
  className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  const segments = 24;
  const lit = Math.round((clamped / 100) * segments);
  const toneClass =
    tone === "danger"
      ? "bg-red-500"
      : tone === "warning"
        ? "bg-amber-400"
        : "bg-foreground";

  return (
    <div className={cn("grid h-3 grid-cols-[repeat(24,minmax(0,1fr))] gap-px", className)}>
      {Array.from({ length: segments }, (_, index) => {
        const active = index < lit;
        const deficit = showDeficitNotch && index === Math.max(0, Math.min(segments - 1, lit - 1));
        return (
          <span
            key={index}
            className={cn(
              "min-w-0 border border-border/40 bg-muted/25",
              active && toneClass,
              deficit && "bg-red-500",
            )}
          />
        );
      })}
    </div>
  );
}

export function DotBar({
  heightPct,
  tone = "default",
  title,
  className,
}: {
  heightPct: number;
  tone?: GlyphTone;
  title?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, heightPct));
  const rows = 12;
  const lit = Math.max(clamped > 0 ? 1 : 0, Math.round((clamped / 100) * rows));
  const dotClass =
    tone === "danger"
      ? "bg-red-500"
      : tone === "warning"
        ? "bg-amber-400"
        : tone === "muted"
          ? "bg-muted-foreground/45"
          : "bg-foreground";

  return (
    <div className={cn("grid h-full grid-rows-12 gap-[2px]", className)} title={title}>
      {Array.from({ length: rows }, (_, index) => {
        const active = rows - index <= lit;
        return (
          <span
            key={index}
            className={cn(
              "mx-auto block h-full w-1.5 rounded-full bg-muted/40",
              active && dotClass,
            )}
          />
        );
      })}
    </div>
  );
}

export function DotStack({
  values,
  title,
}: {
  values: Array<{ key: string; value: number; tone?: GlyphTone; color?: string }>;
  title?: string;
}) {
  const total = values.reduce((sum, entry) => sum + entry.value, 0);
  const rows = 12;
  const orderedDots: Array<{ key: string; tone?: GlyphTone; color?: string }> = [];
  values.forEach((entry) => {
    const count = total > 0 ? Math.max(1, Math.round((entry.value / total) * rows)) : 0;
    for (let i = 0; i < count; i += 1) orderedDots.push({ key: `${entry.key}-${i}`, tone: entry.tone, color: entry.color });
  });
  const visibleDots = orderedDots.slice(0, rows);

  return (
    <div className="grid h-full grid-rows-12 gap-[2px]" title={title}>
      {Array.from({ length: rows }, (_, index) => {
        const dot = visibleDots[rows - 1 - index];
        const style = dot?.color ? ({ "--dot-color": dot.color } as CSSProperties) : undefined;
        const toneClass =
          dot?.tone === "danger"
            ? "bg-red-500"
            : dot?.tone === "warning"
              ? "bg-amber-400"
              : dot
                ? "bg-[var(--dot-color)]"
                : "bg-muted/40";
        return (
          <span
            key={index}
            style={style}
            className={cn("mx-auto block h-full w-1.5 rounded-full", dot ? toneClass : "bg-muted/40")}
          />
        );
      })}
    </div>
  );
}
