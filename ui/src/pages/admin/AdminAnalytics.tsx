import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adminApi, type AdminAnalyticsData, type AdminCurrentMetrics } from "@/api/admin";
import { cn, formatCents } from "@/lib/utils";
import { BarChart2, Download, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ── Period selector ──────────────────────────────────────────── */
type Period = "30d" | "90d" | "12m" | "all";
const PERIODS: { value: Period; label: string; days: number | undefined }[] = [
  { value: "30d", label: "30d", days: 30 },
  { value: "90d", label: "90d", days: 90 },
  { value: "12m", label: "12m", days: 365 },
  { value: "all", label: "All time", days: undefined },
];

/* ── Inline SVG charts ────────────────────────────────────────── */
const CHART_W = 600;
const CHART_H = 140;
const PAD = { top: 12, right: 16, bottom: 28, left: 52 };
const INNER_W = CHART_W - PAD.left - PAD.right;
const INNER_H = CHART_H - PAD.top - PAD.bottom;

function scaleX(i: number, total: number): number {
  if (total <= 1) return PAD.left;
  return PAD.left + (i / (total - 1)) * INNER_W;
}

function scaleY(val: number, min: number, max: number): number {
  if (max === min) return PAD.top + INNER_H / 2;
  return PAD.top + INNER_H - ((val - min) / (max - min)) * INNER_H;
}

function fmtAxisLabel(val: number, unit?: "cents" | "pct" | "count"): string {
  if (unit === "cents") {
    if (val >= 100_000_00) return `$${Math.round(val / 100_000_00)}M`;
    if (val >= 100_00) return `$${Math.round(val / 100_00)}k`;
    return `$${Math.round(val / 100)}`;
  }
  if (unit === "pct") return `${val.toFixed(1)}%`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(Math.round(val));
}

interface DataPoint {
  label: string;
  value: number;
}

function LineChart({
  data,
  color = "#3b82f6",
  unit,
}: {
  data: DataPoint[];
  color?: string;
  unit?: "cents" | "pct" | "count";
}) {
  if (!data.length) return <EmptyChart />;
  const vals = data.map((d) => d.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const points = data.map((d, i) => `${scaleX(i, data.length)},${scaleY(d.value, min, max)}`).join(" ");
  const fillPoints = [
    `${scaleX(0, data.length)},${PAD.top + INNER_H}`,
    points,
    `${scaleX(data.length - 1, data.length)},${PAD.top + INNER_H}`,
  ].join(" ");
  const yTicks = 4;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="w-full"
      style={{ height: CHART_H }}
      aria-hidden="true"
    >
      {/* Grid lines */}
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const y = PAD.top + (INNER_H / yTicks) * i;
        const val = max - ((max - min) / yTicks) * i;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={CHART_W - PAD.right} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
            <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={10} className="fill-muted-foreground" fontFamily="var(--font-sans)">
              {fmtAxisLabel(val, unit)}
            </text>
          </g>
        );
      })}
      {/* X axis labels (show up to 6) */}
      {data.map((d, i) => {
        const step = Math.max(1, Math.floor(data.length / 6));
        if (i % step !== 0 && i !== data.length - 1) return null;
        return (
          <text key={i} x={scaleX(i, data.length)} y={CHART_H - 4} textAnchor="middle" fontSize={10} className="fill-muted-foreground" fontFamily="var(--font-sans)">
            {d.label}
          </text>
        );
      })}
      {/* Area fill */}
      <polygon points={fillPoints} fill={color} fillOpacity={0.07} />
      {/* Line */}
      <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* Data points */}
      {data.map((d, i) => (
        <circle key={i} cx={scaleX(i, data.length)} cy={scaleY(d.value, min, max)} r={3} fill={color} />
      ))}
    </svg>
  );
}

function BarChart({
  data,
  color = "#3b82f6",
  unit,
}: {
  data: DataPoint[];
  color?: string;
  unit?: "cents" | "pct" | "count";
}) {
  if (!data.length) return <EmptyChart />;
  const vals = data.map((d) => d.value);
  const max = Math.max(...vals, 1);
  const barW = Math.max(4, (INNER_W / data.length) * 0.65);
  const yTicks = 4;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="w-full"
      style={{ height: CHART_H }}
      aria-hidden="true"
    >
      {Array.from({ length: yTicks + 1 }, (_, i) => {
        const y = PAD.top + (INNER_H / yTicks) * i;
        const val = max - (max / yTicks) * i;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={CHART_W - PAD.right} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
            <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={10} className="fill-muted-foreground" fontFamily="var(--font-sans)">
              {fmtAxisLabel(val, unit)}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = scaleX(i, data.length) - barW / 2;
        const barH = (d.value / max) * INNER_H;
        const y = PAD.top + INNER_H - barH;
        const step = Math.max(1, Math.floor(data.length / 6));
        const showLabel = i % step === 0 || i === data.length - 1;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} fill={color} fillOpacity={0.75} rx={2} />
            {showLabel && (
              <text x={scaleX(i, data.length)} y={CHART_H - 4} textAnchor="middle" fontSize={10} className="fill-muted-foreground" fontFamily="var(--font-sans)">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function EmptyChart() {
  return (
    <div className="flex items-center justify-center h-[140px] text-xs text-muted-foreground">
      No data available
    </div>
  );
}

/* ── Chart card wrapper ───────────────────────────────────────── */
function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

/* ── Summary card ─────────────────────────────────────────────── */
function SummaryCard({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: "up" | "down" | "flat";
}) {
  const TrendIcon =
    trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : null;
  const trendColor =
    trend === "up" ? "text-emerald-400" : trend === "down" ? "text-red-400" : "text-muted-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums">{value}</span>
        {TrendIcon && <TrendIcon className={cn("h-4 w-4 shrink-0", trendColor)} />}
      </div>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────── */
export default function AdminAnalytics() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [period, setPeriod] = useState<Period>("90d");
  const selectedDays = PERIODS.find((p) => p.value === period)?.days;

  useEffect(() => {
    setBreadcrumbs([
      { label: "IronWorks Admin" },
      { label: "Analytics" },
    ]);
  }, [setBreadcrumbs]);

  const analyticsQuery = useQuery({
    queryKey: ["admin", "analytics", selectedDays],
    queryFn: () => adminApi.getAnalytics(selectedDays),
    staleTime: 2 * 60 * 1_000,
  });

  const metricsQuery = useQuery({
    queryKey: ["admin", "analytics", "current"],
    queryFn: () => adminApi.getCurrentMetrics(),
    staleTime: 60_000,
  });

  const data: AdminAnalyticsData | undefined = analyticsQuery.data;
  const current: AdminCurrentMetrics | undefined = metricsQuery.data;

  const mrrPoints = useMemo<DataPoint[]>(() => data?.mrr ?? [], [data]);
  const signupsPoints = useMemo<DataPoint[]>(() => data?.signups ?? [], [data]);
  const churnPoints = useMemo<DataPoint[]>(() => data?.churn ?? [], [data]);
  const utilizationPoints = useMemo<DataPoint[]>(() => data?.agentUtilization ?? [], [data]);

  const isLoading = analyticsQuery.isLoading || metricsQuery.isLoading;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Analytics</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Period selector */}
          <div className="flex rounded-md border border-border overflow-hidden text-xs">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPeriod(p.value)}
                className={cn(
                  "px-3 py-1.5 transition-colors",
                  period === p.value
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => adminApi.exportAnalytics()}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => {
              analyticsQuery.refetch();
              metricsQuery.refetch();
            }}
            disabled={isLoading}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryCard
          label="Current MRR"
          value={current ? formatCents(current.mrrCents) : "—"}
          sub={current?.mrrGrowthPct !== undefined ? `${current.mrrGrowthPct >= 0 ? "+" : ""}${current.mrrGrowthPct.toFixed(1)}% MoM` : undefined}
          trend={current?.mrrGrowthPct !== undefined ? (current.mrrGrowthPct > 0 ? "up" : current.mrrGrowthPct < 0 ? "down" : "flat") : undefined}
        />
        <SummaryCard
          label="Growth Rate"
          value={current ? `${current.mrrGrowthPct >= 0 ? "+" : ""}${current.mrrGrowthPct.toFixed(1)}%` : "—"}
          sub="MRR month-over-month"
          trend={current?.mrrGrowthPct !== undefined ? (current.mrrGrowthPct > 0 ? "up" : "down") : undefined}
        />
        <SummaryCard
          label="Total Signups"
          value={current ? current.totalSignups.toLocaleString() : "—"}
          sub="All time"
        />
        <SummaryCard
          label="Churn Rate"
          value={current ? `${current.churnRatePct.toFixed(2)}%` : "—"}
          sub="Current monthly"
          trend={current?.churnRatePct !== undefined ? (current.churnRatePct > 3 ? "down" : "up") : undefined}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="MRR Trend">
          <LineChart data={mrrPoints} color="#3b82f6" unit="cents" />
        </ChartCard>
        <ChartCard title="New Signups">
          <BarChart data={signupsPoints} color="#22c55e" unit="count" />
        </ChartCard>
        <ChartCard title="Churn Rate (%)">
          <LineChart data={churnPoints} color="#f97316" unit="pct" />
        </ChartCard>
        <ChartCard title="Agent Utilization (runs/agent)">
          <LineChart data={utilizationPoints} color="#a855f7" unit="count" />
        </ChartCard>
      </div>
    </div>
  );
}
