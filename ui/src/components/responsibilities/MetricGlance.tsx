import type { ResponsibilityHealth, ResponsibilityMetricSummary } from "@paperclipai/shared";
import { describeMetricReading, describeStale, type MetricReading } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";
import { healthStatusStyle, StaleFlag } from "./ResponsibilityHealthBadge";

/** How far the reading is toward its target, in the status hue. Width is the measured share (data). */
export function MetricProgress({
  progress,
  health,
  label,
  className,
}: {
  progress: number | null;
  health: ResponsibilityHealth;
  label: string;
  className?: string;
}) {
  const percent = progress === null ? 0 : Math.round(progress * 100);
  return (
    <div
      className={cn("flex h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      {progress !== null ? (
        <div className="status-fill h-full rounded-full" style={{ ...healthStatusStyle(health), width: `${percent}%` }} />
      ) : null}
    </div>
  );
}

/**
 * The reading drawn for its bar template: a fill toward the target (volume,
 * percentage), the range as a band with the reading as a marker on it (range),
 * or nothing for a yes or no, whose answer is the reading itself. Every
 * responsibility view draws its metric through this one component.
 */
export function MetricMeter({
  reading,
  health,
  label,
  className,
}: {
  reading: MetricReading;
  health: ResponsibilityHealth;
  label: string;
  className?: string;
}) {
  const { visual } = reading;
  if (visual.kind === "yes_no") return null;
  if (visual.kind === "fill") {
    return <MetricProgress progress={visual.progress} health={health} label={label} className={className} />;
  }
  const percent = (share: number) => `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`;
  return (
    <div
      className={cn("relative h-1.5 w-full rounded-full bg-muted", className)}
      role="img"
      aria-label={`${label}: ${reading.summary}`}
    >
      <div
        className="absolute inset-y-0 rounded-full bg-muted-foreground/30"
        style={{ left: percent(visual.low), width: percent(visual.high - visual.low) }}
      />
      {visual.marker !== null ? (
        <div
          className="status-fill absolute -inset-y-0.5 w-1 -translate-x-1/2 rounded-full"
          style={{ ...healthStatusStyle(health), left: percent(visual.marker) }}
        />
      ) : null}
    </div>
  );
}

/**
 * The number against its target, as it reads at a glance: "9 of 20", a thin
 * bar in the status hue, and the metric's name. `size="hero"` is the large
 * version at the top of a responsibility's page.
 */
export function MetricGlance({
  metric,
  health,
  now,
  size = "row",
  className,
}: {
  metric: ResponsibilityMetricSummary | null;
  health: ResponsibilityHealth;
  now: Date;
  size?: "row" | "hero";
  className?: string;
}) {
  if (!metric) {
    return <p className={cn("text-sm text-muted-foreground", className)}>No number to track yet</p>;
  }
  const reading = describeMetricReading(metric);
  const hero = size === "hero";
  return (
    <div className={cn("flex min-w-0 flex-col", hero ? "gap-2" : "gap-1", className)}>
      <p className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums" aria-label={reading.summary}>
        <span className={cn("font-semibold text-foreground", hero ? "text-2xl" : "text-sm")}>
          {reading.current ?? "No reading yet"}
        </span>
        <span className={cn("text-muted-foreground", hero ? "text-sm" : "text-xs")}>{reading.targetLabel}</span>
      </p>
      <MetricMeter reading={reading} health={health} label={`${metric.name}, toward its bar`} />
      <p className={cn("flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground", hero ? "text-sm" : "text-xs")}>
        <span className={cn(!hero && "truncate")}>{metric.name}</span>
        {metric.stale && metric.updatedAt ? <StaleFlag label={describeStale(metric.updatedAt, now)} /> : null}
      </p>
    </div>
  );
}
