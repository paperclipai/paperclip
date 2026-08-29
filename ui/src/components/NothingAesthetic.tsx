import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Smoothly tweens between integer values whenever `value` changes.
 * Renders via the formatter so the consumer controls display (e.g., `formatTokens`).
 */
export function AnimatedNumber({
  value,
  durationMs = 900,
  format = (n) => Math.round(n).toLocaleString("en-US"),
  className,
}: {
  value: number;
  durationMs?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const startRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (value === display) return;
    fromRef.current = display;
    startRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    const tick = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const progress = Math.min(1, (ts - startRef.current) / durationMs);
      const next = fromRef.current + (value - fromRef.current) * easeOutCubic(progress);
      setDisplay(next);
      if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs]);

  return <span className={className}>{format(display)}</span>;
}

type GlyphTone = "default" | "muted" | "success" | "warning" | "danger" | "live";

const toneClasses: Record<GlyphTone, string> = {
  default: "dashboard-tone-accent",
  muted: "dashboard-tone-muted",
  success: "dashboard-tone-positive",
  warning: "dashboard-tone-warning",
  danger: "dashboard-tone-danger",
  live: "dashboard-tone-live",
};

export function DotMatrixText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-display tabular-nums tracking-normal", className)}>
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
          active && "dashboard-glyph-active",
          broken && "dashboard-glyph-broken-border",
        )}
      />
      <span className="dashboard-glyph-inner rounded-full border border-dotted border-current/35" />
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current/80",
          complete && "h-2.5 w-2.5",
          broken && "dashboard-glyph-broken",
        )}
      />
      {broken ? <span className="absolute h-px w-4 rotate-45 dashboard-glyph-broken-line" /> : null}
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
      ? "dashboard-progress-danger"
      : tone === "warning"
        ? "dashboard-progress-warning"
        : tone === "success"
          ? "dashboard-progress-positive"
          : "dashboard-progress-accent";

  return (
    <div className={cn("dashboard-led-grid grid h-3 gap-px", className)}>
      {Array.from({ length: segments }, (_, index) => {
        const active = index < lit;
        const deficit = showDeficitNotch && index === Math.max(0, Math.min(segments - 1, lit - 1));
        return (
          <span
            key={index}
            className={cn(
              "min-w-0 border dashboard-progress-track",
              active && toneClass,
              deficit && "dashboard-progress-danger",
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
      ? "dashboard-progress-danger"
      : tone === "warning"
        ? "dashboard-progress-warning"
        : tone === "success"
          ? "dashboard-progress-positive"
        : tone === "muted"
          ? "dashboard-progress-neutral"
          : "dashboard-progress-accent";

  return (
    <div className={cn("grid h-full grid-rows-12 gap-(--sz-2px)", className)} title={title}>
      {Array.from({ length: rows }, (_, index) => {
        const active = rows - index <= lit;
        return (
          <span
            key={index}
            className={cn(
              "mx-auto block h-full w-1.5 rounded-full dashboard-progress-dot",
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
  const positiveValues = values.filter((entry) => entry.value > 0);
  const allocations = new Map<string, number>();
  let allocated = 0;

  if (total > 0) {
    const weighted = positiveValues.map((entry) => {
      const exact = (entry.value / total) * rows;
      const count = Math.max(1, Math.floor(exact));
      allocated += count;
      return { entry, count, remainder: exact - Math.floor(exact) };
    });

    while (allocated > rows) {
      const candidate = weighted
        .filter((item) => item.count > 1)
        .sort((a, b) => a.remainder - b.remainder)[0];
      if (!candidate) break;
      candidate.count -= 1;
      allocated -= 1;
    }

    while (allocated < rows) {
      const candidate = weighted
        .filter((item) => item.count < rows)
        .sort((a, b) => b.remainder - a.remainder)[0];
      if (!candidate) break;
      candidate.count += 1;
      allocated += 1;
    }

    weighted.forEach(({ entry, count }) => allocations.set(entry.key, count));
  }

  const orderedDots: Array<{ key: string; tone?: GlyphTone; color?: string }> = [];
  values.forEach((entry) => {
    const count = allocations.get(entry.key) ?? 0;
    for (let i = 0; i < count; i += 1) orderedDots.push({ key: `${entry.key}-${i}`, tone: entry.tone, color: entry.color });
  });
  const visibleDots = orderedDots.slice(0, rows);

  return (
    <div className="grid h-full grid-rows-12 gap-(--sz-2px)" title={title}>
      {Array.from({ length: rows }, (_, index) => {
        const dot = visibleDots[rows - 1 - index];
        const style = dot?.color ? ({ backgroundColor: dot.color } as CSSProperties) : undefined;
        const toneClass =
          dot?.tone === "danger"
            ? "dashboard-progress-danger"
            : dot?.tone === "warning"
              ? "dashboard-progress-warning"
              : dot?.tone === "success"
                ? "dashboard-progress-positive"
              : dot?.color
                ? ""
                : dot
                  ? "dashboard-progress-neutral"
                  : "dashboard-progress-dot";
        return (
          <span
            key={index}
            style={style}
            className={cn("mx-auto block h-full w-1.5 rounded-full", toneClass)}
          />
        );
      })}
    </div>
  );
}
