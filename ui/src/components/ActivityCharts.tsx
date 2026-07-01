import type { DashboardRunActivityDay, HeartbeatRun } from "@paperclipai/shared";
import { Bar, BarChart, CartesianGrid, Cell, XAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "./ui/chart";

/* ---- Utilities ---- */

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/* Render the m/d label only at the first, middle, and last tick — mirrors the
   sparse cadence the bespoke chart used so 14 bars don't crowd the axis. */
function sparseDayTick(value: string, index: number, total: number): string {
  return index === 0 || index === Math.floor(total / 2) || index === total - 1
    ? formatDayLabel(value)
    : "";
}

const EMPTY_RUN_DAY = { succeeded: 0, failed: 0, other: 0, total: 0 } as const;

/* The shadcn ChartContainer sizes its ResponsiveContainer to this div, so the
   class must give the chart real height — `aspect-auto` clears the component's
   default `aspect-video` so the explicit height wins. A recharts <Legend> is
   drawn inside the SVG and steals from the total height, so charts that carry a
   legend get extra room (≈180px plot + ≈40px legend) while plain charts size
   the plot directly. */
const chartContainerClass = "aspect-auto h-44 w-full";
const chartContainerWithLegendClass = "aspect-auto h-52 w-full";

/* ---- Shared card (consumed by Dashboard + AgentDetail) ---- */

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {subtitle && <CardDescription className="text-xs">{subtitle}</CardDescription>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  );
}

/* ---- Run activity ---- */

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never };

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, { date: day, succeeded: 0, failed: 0, other: 0, total: 0 });
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") entry.succeeded++;
    else if (run.status === "failed" || run.status === "timed_out") entry.failed++;
    else entry.other++;
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

function fillRunDays(activity: DashboardRunActivityDay[]): DashboardRunActivityDay[] {
  if (activity.length > 0) return activity;
  return getLast14Days().map((date) => ({ date, ...EMPTY_RUN_DAY }));
}

const runActivityConfig = {
  succeeded: { label: "Succeeded", color: "var(--data-run-succeeded)" },
  failed: { label: "Failed", color: "var(--data-run-failed)" },
  other: { label: "Other", color: "var(--data-run-other)" },
} satisfies ChartConfig;

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const hasData = activity.some((v) => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  const data = fillRunDays(activity);

  return (
    <ChartContainer config={runActivityConfig} className={chartContainerClass}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={0}
          interval={0}
          tickFormatter={(value, index) => sparseDayTick(value, index, data.length)}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => formatDayLabel(payload?.[0]?.payload?.date ?? "")} />}
        />
        <Bar dataKey="succeeded" stackId="runs" fill="var(--color-succeeded)" />
        <Bar dataKey="failed" stackId="runs" fill="var(--color-failed)" />
        <Bar dataKey="other" stackId="runs" fill="var(--color-other)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

/* ---- Tasks by priority ---- */

const priorityConfig = {
  critical: { label: "Critical", color: "var(--data-priority-critical)" },
  high: { label: "High", color: "var(--data-priority-high)" },
  medium: { label: "Medium", color: "var(--data-priority-medium)" },
  low: { label: "Low", color: "var(--data-priority-low)" },
} satisfies ChartConfig;

const priorityOrder = ["critical", "high", "medium", "low"] as const;

export function PriorityChart({ issues }: { issues: { priority: string; createdAt: Date }[] }) {
  const days = getLast14Days();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, { critical: 0, high: 0, medium: 0, low: 0 });
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority in entry) entry[issue.priority]++;
  }

  const data = days.map((date) => {
    const entry = grouped.get(date) ?? { critical: 0, high: 0, medium: 0, low: 0 };
    return { date, ...entry } as { date: string } & Record<(typeof priorityOrder)[number], number>;
  });
  const hasData = data.some((d) => priorityOrder.some((p) => d[p] > 0));
  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <ChartContainer config={priorityConfig} className={chartContainerWithLegendClass}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={0}
          interval={0}
          tickFormatter={(value, index) => sparseDayTick(value, index, data.length)}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => formatDayLabel(payload?.[0]?.payload?.date ?? "")} />}
        />
        {priorityOrder.map((p, i) => (
          <Bar
            key={p}
            dataKey={p}
            stackId="priority"
            fill={`var(--color-${p})`}
            radius={i === priorityOrder.length - 1 ? [2, 2, 0, 0] : undefined}
          />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}

/* ---- Tasks by status ---- */

const statusConfig = {
  todo: { label: "To Do", color: "var(--data-status-todo)" },
  in_progress: { label: "In Progress", color: "var(--data-status-in-progress)" },
  in_review: { label: "In Review", color: "var(--data-status-in-review)" },
  done: { label: "Done", color: "var(--data-status-done)" },
  blocked: { label: "Blocked", color: "var(--data-status-blocked)" },
  cancelled: { label: "Cancelled", color: "var(--data-status-cancelled)" },
  backlog: { label: "Backlog", color: "var(--data-status-backlog)" },
} satisfies ChartConfig;

const statusOrderAll = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"] as const;

export function IssueStatusChart({ issues }: { issues: { status: string; createdAt: Date }[] }) {
  const days = getLast14Days();
  const allStatuses = new Set<string>();
  const grouped = new Map<string, Record<string, number>>();
  for (const day of days) grouped.set(day, {});
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry[issue.status] = (entry[issue.status] ?? 0) + 1;
    allStatuses.add(issue.status);
  }

  const statusOrder = statusOrderAll.filter((s) => allStatuses.has(s));
  const hasData = allStatuses.size > 0;
  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  const data = days.map((date) => {
    const entry = grouped.get(date) ?? {};
    const row: Record<string, number | string> = { date };
    for (const s of statusOrder) row[s] = entry[s] ?? 0;
    return row;
  });

  return (
    <ChartContainer config={statusConfig} className={chartContainerWithLegendClass}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={0}
          interval={0}
          tickFormatter={(value, index) => sparseDayTick(String(value), index, data.length)}
        />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent labelFormatter={(_, payload) => formatDayLabel(String(payload?.[0]?.payload?.date ?? ""))} />}
        />
        {statusOrder.map((s, i) => (
          <Bar
            key={s}
            dataKey={s}
            stackId="status"
            fill={`var(--color-${s})`}
            radius={i === statusOrder.length - 1 ? [2, 2, 0, 0] : undefined}
          />
        ))}
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  );
}

/* ---- Success rate ---- */

const successRateConfig = {
  rate: { label: "Success rate" },
  high: { label: "≥ 80%", color: "var(--data-rate-high)" },
  mid: { label: "50–79%", color: "var(--data-rate-mid)" },
  low: { label: "< 50%", color: "var(--data-rate-low)" },
} satisfies ChartConfig;

function rateBand(rate: number): "high" | "mid" | "low" {
  return rate >= 0.8 ? "high" : rate >= 0.5 ? "mid" : "low";
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const hasData = activity.some((v) => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  const data = fillRunDays(activity).map((day) => {
    const rate = day.total > 0 ? day.succeeded / day.total : 0;
    return {
      date: day.date,
      rate: Math.round(rate * 100),
      band: rateBand(rate),
      total: day.total,
      succeeded: day.succeeded,
      empty: day.total === 0,
    };
  });

  return (
    <ChartContainer config={successRateConfig} className={chartContainerClass}>
      <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          minTickGap={0}
          interval={0}
          tickFormatter={(value, index) => sparseDayTick(value, index, data.length)}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) => formatDayLabel(payload?.[0]?.payload?.date ?? "")}
              formatter={(_value, _name, item) => {
                const p = item.payload as { rate: number; succeeded: number; total: number };
                return `${p.rate}% (${p.succeeded}/${p.total})`;
              }}
            />
          }
        />
        <Bar dataKey="rate" radius={[2, 2, 0, 0]}>
          {data.map((d) => (
            <Cell key={d.date} fill={d.empty ? "var(--muted)" : `var(--color-${d.band})`} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
