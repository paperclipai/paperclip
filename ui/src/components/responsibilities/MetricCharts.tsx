import type { CSSProperties, ReactNode } from "react";
import type { ResponsibilityMetricView } from "@paperclipai/shared";
import {
  barRects,
  CHART_HEIGHT,
  CHART_WIDTH,
  chartDomain,
  describeMetricChart,
  formatChartDate,
  formatMetricViewValue,
  leftShare,
  linePath,
  linePoints,
  metricReferences,
  ringDash,
  topShare,
  yFor,
} from "@/lib/metric-charts";
import { RESPONSIBILITY_HEALTH_TEXT_VAR } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";

/**
 * Small charts for a responsibility's metrics, drawn as inline SVG with
 * tokens: a line over time, bars per week, and a ring for a share. The plot
 * stretches to its box; strokes keep their width and labels are HTML, so
 * they stay legible at any width. Each chart carries a text alternative and
 * a visually hidden table of its readings, and marks the target with a
 * dashed line and its words, so nothing rests on colour alone.
 */

type ChartMetric = Pick<
  ResponsibilityMetricView,
  "title" | "display" | "unit" | "target" | "direction" | "kind" | "low" | "high" | "readings" | "health" | "role" | "period"
>;

/** The series colour: the primary metric wears its status hue; supporting metrics the foreground. */
export function seriesStyle(metric: Pick<ResponsibilityMetricView, "health" | "role">): CSSProperties {
  return metric.role === "primary" && metric.health
    ? ({ "--series": `var(${RESPONSIBILITY_HEALTH_TEXT_VAR[metric.health]})` } as CSSProperties)
    : ({ "--series": "var(--foreground)" } as CSSProperties);
}

function percent(share: number) {
  return `${Math.round(share * 1000) / 10}%`;
}

/** The readings as a table, for screen readers. */
function ReadingsTable({ metric }: { metric: ChartMetric & Pick<ResponsibilityMetricView, "title"> }) {
  if (metric.readings.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>{metric.title}</caption>
      <thead>
        <tr>
          <th scope="col">{metric.period === "week" ? "Week of" : "Read on"}</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        {metric.readings.map((reading, index) => (
          <tr key={reading.id ?? `${reading.recordedAt}:${index}`}>
            <td>{formatChartDate(reading.recordedAt)}</td>
            <td>{formatMetricViewValue(metric, reading.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A reference line's words, just above it at the left edge (the newest reading sits at the right). */
function ReferenceLines({ lines, domain }: { lines: { value: number; label: string }[]; domain: ReturnType<typeof chartDomain> }) {
  return (
    <>
      {lines.map((line) => (
        <span
          key={line.label}
          className="pointer-events-none absolute left-0 -translate-y-full rounded-sm bg-card/80 px-1 text-xs leading-none text-muted-foreground"
          style={{ top: percent(topShare(yFor(domain, line.value))) }}
          data-reference-line=""
        >
          {line.label}
        </span>
      ))}
    </>
  );
}

function ChartFrame({
  metric,
  children,
  overlay,
  empty,
  className,
}: {
  metric: ChartMetric;
  children: ReactNode;
  overlay?: ReactNode;
  empty?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)} data-metric-chart={metric.display}>
      <div className="relative h-16 w-full" style={seriesStyle(metric)} role="img" aria-label={describeMetricChart(metric as ResponsibilityMetricView)}>
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
          aria-hidden="true"
          focusable="false"
        >
          {children}
        </svg>
        {overlay}
        {empty ? (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{empty}</span>
        ) : null}
      </div>
      <ReadingsTable metric={metric} />
    </div>
  );
}

/** The first and last dates under a chart. */
function AxisDates({ first, last }: { first: string | null; last: string | null }) {
  if (!first) return null;
  return (
    <div className="flex justify-between text-xs tabular-nums text-muted-foreground" aria-hidden="true">
      <span>{formatChartDate(first)}</span>
      {last && last !== first ? <span>{formatChartDate(last)}</span> : null}
    </div>
  );
}

/**
 * Readings over time as a line, with the target (or a range's bounds) as a
 * dashed reference. None: an empty frame that says so. One: a single dot.
 */
export function MetricLineChart({ metric, className }: { metric: ChartMetric; className?: string }) {
  const references = metricReferences(metric);
  const domain = chartDomain(
    metric.readings.map((reading) => reading.value),
    references.map((line) => line.value),
    { percent: metric.display === "percent" || metric.unit === "%" },
  );
  const points = linePoints(metric.readings, domain);
  const path = linePath(points);
  const last = points.at(-1) ?? null;
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <ChartFrame
        metric={metric}
        empty={points.length === 0 ? "No readings yet" : null}
        overlay={
          <>
            <ReferenceLines lines={references} domain={domain} />
            {last ? (
              <span
                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-(--series) ring-2 ring-card"
                style={{ left: percent(leftShare(last.x)), top: percent(topShare(last.y)) }}
                data-latest-point=""
              />
            ) : null}
          </>
        }
      >
        <line x1={0} x2={CHART_WIDTH} y1={CHART_HEIGHT} y2={CHART_HEIGHT} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {references.map((line) => (
          <line
            key={line.label}
            x1={0}
            x2={CHART_WIDTH}
            y1={yFor(domain, line.value)}
            y2={yFor(domain, line.value)}
            className="stroke-muted-foreground"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            data-target-line=""
          />
        ))}
        {path ? (
          <path d={path} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-series-line="" />
        ) : null}
        {points.map((point, index) => {
          // Each reading's hover target spans halfway to its neighbours.
          const left = index === 0 ? 0 : (points[index - 1]!.x + point.x) / 2;
          const right = index === points.length - 1 ? CHART_WIDTH : (point.x + points[index + 1]!.x) / 2;
          return (
            <rect key={`${point.recordedAt}:${index}`} x={left} width={Math.max(0, right - left)} y={0} height={CHART_HEIGHT} fill="transparent">
              <title>{`${formatChartDate(point.recordedAt)}: ${formatMetricViewValue(metric, point.value)}`}</title>
            </rect>
          );
        })}
      </ChartFrame>
      <AxisDates first={metric.readings[0]?.recordedAt ?? null} last={metric.readings.at(-1)?.recordedAt ?? null} />
    </div>
  );
}

/**
 * One bar per period (a week), from zero, with the target as a dashed
 * reference. A zero is a stub on the baseline; the newest bar is solid and
 * the others lighter, so the current week reads first.
 */
export function MetricBarChart({ metric, className }: { metric: ChartMetric; className?: string }) {
  const references = metricReferences(metric);
  const domain = chartDomain(
    metric.readings.map((reading) => reading.value),
    references.map((line) => line.value),
    { zeroBased: true, percent: metric.display === "percent" || metric.unit === "%" },
  );
  const bars = barRects(metric.readings, domain);
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <ChartFrame
        metric={metric}
        empty={bars.length === 0 ? "No readings yet" : null}
        overlay={<ReferenceLines lines={references} domain={domain} />}
      >
        <line x1={0} x2={CHART_WIDTH} y1={CHART_HEIGHT} y2={CHART_HEIGHT} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {bars.map((bar, index) => (
          <rect
            key={`${bar.recordedAt}:${index}`}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            fill="var(--series)"
            fillOpacity={bar.zero ? 0.35 : index === bars.length - 1 ? 1 : 0.55}
            data-bar=""
            data-zero={bar.zero ? "" : undefined}
          >
            <title>{`Week of ${formatChartDate(bar.recordedAt)}: ${formatMetricViewValue(metric, bar.value)}`}</title>
          </rect>
        ))}
        {references.map((line) => (
          <line
            key={line.label}
            x1={0}
            x2={CHART_WIDTH}
            y1={yFor(domain, line.value)}
            y2={yFor(domain, line.value)}
            className="stroke-muted-foreground"
            strokeWidth={1}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
            data-target-line=""
          />
        ))}
      </ChartFrame>
      <AxisDates first={metric.readings[0]?.recordedAt ?? null} last={metric.readings.at(-1)?.recordedAt ?? null} />
    </div>
  );
}

const RING_RADIUS = 15.9155; // a circumference of 100 in a 36 × 36 box

/**
 * A share from 0 to 100 as a ring: the filled arc is the reading, and a tick
 * across the ring marks the target. Without a reading the ring is empty.
 */
export function MetricRing({
  metric,
  value,
  size = "md",
  className,
}: {
  metric: Pick<ResponsibilityMetricView, "health" | "role" | "target" | "title">;
  value: number | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const share = value === null ? 0 : value / 100;
  const { dasharray } = ringDash(share, RING_RADIUS);
  const targetAngle = metric.target === null ? null : (Math.min(100, Math.max(0, metric.target)) / 100) * 2 * Math.PI - Math.PI / 2;
  return (
    <svg
      viewBox="0 0 36 36"
      className={cn("shrink-0", size === "sm" ? "size-8" : "size-14", className)}
      style={seriesStyle(metric)}
      aria-hidden="true"
      focusable="false"
      data-metric-ring=""
    >
      <circle cx={18} cy={18} r={RING_RADIUS} fill="none" className="stroke-muted" strokeWidth={3.5} />
      {value !== null && value > 0 ? (
        <circle
          cx={18}
          cy={18}
          r={RING_RADIUS}
          fill="none"
          stroke="var(--series)"
          strokeWidth={3.5}
          strokeDasharray={dasharray}
          strokeDashoffset={25}
          strokeLinecap={share >= 1 ? "butt" : "round"}
          data-ring-fill=""
        />
      ) : null}
      {targetAngle !== null ? (
        <line
          x1={18 + Math.cos(targetAngle) * (RING_RADIUS - 3.5)}
          y1={18 + Math.sin(targetAngle) * (RING_RADIUS - 3.5)}
          x2={18 + Math.cos(targetAngle) * (RING_RADIUS + 3.5)}
          y2={18 + Math.sin(targetAngle) * (RING_RADIUS + 3.5)}
          className="stroke-foreground"
          strokeWidth={1.5}
          data-ring-target=""
        />
      ) : null}
    </svg>
  );
}
