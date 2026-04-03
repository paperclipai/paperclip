import type { HeartbeatRun } from "@paperclipai/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type LegendItem = { color: string; label: string };
type TooltipMetric = { color?: string; label: string; value: string | number };

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

function formatTooltipDate(dateStr: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(dateStr + "T12:00:00"));
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-[3px] mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(i === 0 || i === 6 || i === 13) ? (
            <span className="text-[9px] text-muted-foreground tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {subtitle && <span className="text-[10px] text-muted-foreground/60">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function ChartTooltipBody({
  day,
  summaryLabel,
  summaryValue,
  metrics,
}: {
  day: string;
  summaryLabel: string;
  summaryValue: string | number;
  metrics: TooltipMetric[];
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-[11px] font-medium">{formatTooltipDate(day)}</p>
        <div className="flex items-center justify-between gap-3 text-[11px]">
          <span className="text-background/70">{summaryLabel}</span>
          <span className="font-medium tabular-nums">{summaryValue}</span>
        </div>
      </div>
      <div className="space-y-1">
        {metrics.map(metric => (
          <div key={metric.label} className="flex items-center justify-between gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 text-background/70">
              {metric.color ? (
                <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: metric.color }} />
              ) : null}
              {metric.label}
            </span>
            <span className="font-medium tabular-nums text-right">{metric.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartBarColumn({
  day,
  summaryLabel,
  summaryValue,
  metrics,
  children,
}: {
  day: string;
  summaryLabel: string;
  summaryValue: string | number;
  metrics: TooltipMetric[];
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex-1 h-full flex flex-col justify-end rounded-[2px] cursor-default focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={`${formatTooltipDate(day)} ${summaryLabel} ${summaryValue}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="min-w-44 px-3 py-2">
        <ChartTooltipBody
          day={day}
          summaryLabel={summaryLabel}
          summaryValue={summaryValue}
          metrics={metrics}
        />
      </TooltipContent>
    </Tooltip>
  );
}

/* ---- Chart Components ---- */

const runActivityColors = {
  succeeded: "#10b981",
  failed: "#ef4444",
  other: "#737373",
};

const runActivityLegend: LegendItem[] = [
  { color: runActivityColors.succeeded, label: "Succeeded" },
  { color: runActivityColors.failed, label: "Failed" },
  { color: runActivityColors.other, label: "Other" },
];

export function RunActivityChart({ runs }: { runs: HeartbeatRun[] }) {
  const days = getLast14Days();

  const grouped = new Map<string, { succeeded: number; failed: number; other: number }>();
  for (const day of days) grouped.set(day, { succeeded: 0, failed: 0, other: 0 });
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") entry.succeeded++;
    else if (run.status === "failed" || run.status === "timed_out") entry.failed++;
    else entry.other++;
  }

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => v.succeeded + v.failed + v.other), 1);
  const hasData = Array.from(grouped.values()).some(v => v.succeeded + v.failed + v.other > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = entry.succeeded + entry.failed + entry.other;
          const heightPct = (total / maxValue) * 100;
          return (
            <ChartBarColumn
              key={day}
              day={day}
              summaryLabel="Runs"
              summaryValue={total}
              metrics={[
                { color: runActivityColors.succeeded, label: "Succeeded", value: entry.succeeded },
                { color: runActivityColors.failed, label: "Failed", value: entry.failed },
                { color: runActivityColors.other, label: "Other", value: entry.other },
              ]}
            >
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div style={{ flex: entry.succeeded, backgroundColor: runActivityColors.succeeded }} />}
                  {entry.failed > 0 && <div style={{ flex: entry.failed, backgroundColor: runActivityColors.failed }} />}
                  {entry.other > 0 && <div style={{ flex: entry.other, backgroundColor: runActivityColors.other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </ChartBarColumn>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={runActivityLegend} />
    </div>
  );
}

const priorityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
};

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

  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = Array.from(grouped.values()).some(v => Object.values(v).reduce((a, b) => a + b, 0) > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No issues</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <ChartBarColumn
              key={day}
              day={day}
              summaryLabel="Issues"
              summaryValue={total}
              metrics={priorityOrder.map((priority) => ({
                color: priorityColors[priority],
                label: priority.charAt(0).toUpperCase() + priority.slice(1),
                value: entry[priority],
              }))}
            >
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {priorityOrder.map(p => entry[p] > 0 ? (
                    <div key={p} style={{ flex: entry[p], backgroundColor: priorityColors[p] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </ChartBarColumn>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
    </div>
  );
}

const statusColors: Record<string, string> = {
  todo: "#3b82f6",
  in_progress: "#8b5cf6",
  in_review: "#a855f7",
  done: "#10b981",
  blocked: "#ef4444",
  cancelled: "#6b7280",
  backlog: "#64748b",
};

const statusLabels: Record<string, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
  backlog: "Backlog",
};

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

  const statusOrder = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"].filter(s => allStatuses.has(s));
  const maxValue = Math.max(...Array.from(grouped.values()).map(v => Object.values(v).reduce((a, b) => a + b, 0)), 1);
  const hasData = allStatuses.size > 0;

  if (!hasData) return <p className="text-xs text-muted-foreground">No issues</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <ChartBarColumn
              key={day}
              day={day}
              summaryLabel="Issues"
              summaryValue={total}
              metrics={statusOrder.map((status) => ({
                color: statusColors[status] ?? "#6b7280",
                label: statusLabels[status] ?? status,
                value: entry[status] ?? 0,
              }))}
            >
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {statusOrder.map(s => (entry[s] ?? 0) > 0 ? (
                    <div key={s} style={{ flex: entry[s], backgroundColor: statusColors[s] ?? "#6b7280" }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </ChartBarColumn>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "#6b7280", label: statusLabels[s] ?? s }))} />
    </div>
  );
}

const successRateLegend: LegendItem[] = [
  { color: "#10b981", label: ">= 80%" },
  { color: "#eab308", label: "50-79%" },
  { color: "#ef4444", label: "< 50%" },
];

function getSuccessRateBand(rate: number, total: number): { color?: string; label: string } {
  if (total === 0) return { label: "No runs" };
  if (rate >= 0.8) return { color: "#10b981", label: ">= 80%" };
  if (rate >= 0.5) return { color: "#eab308", label: "50-79%" };
  return { color: "#ef4444", label: "< 50%" };
}

export function SuccessRateChart({ runs }: { runs: HeartbeatRun[] }) {
  const days = getLast14Days();
  const grouped = new Map<string, { succeeded: number; total: number }>();
  for (const day of days) grouped.set(day, { succeeded: 0, total: 0 });
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    entry.total++;
    if (run.status === "succeeded") entry.succeeded++;
  }

  const hasData = Array.from(grouped.values()).some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const rate = entry.total > 0 ? entry.succeeded / entry.total : 0;
          const unsuccessful = entry.total - entry.succeeded;
          const band = getSuccessRateBand(rate, entry.total);
          return (
            <ChartBarColumn
              key={day}
              day={day}
              summaryLabel="Success rate"
              summaryValue={formatPercent(rate)}
              metrics={[
                { color: "#10b981", label: "Succeeded", value: entry.succeeded },
                { color: "#ef4444", label: "Unsuccessful", value: unsuccessful },
                { label: "Total runs", value: entry.total },
                { color: band.color, label: "Band", value: band.label },
              ]}
            >
              {entry.total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: band.color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </ChartBarColumn>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={successRateLegend} />
    </div>
  );
}
