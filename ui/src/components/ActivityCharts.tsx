import type { DashboardRunActivityDay, HeartbeatRun } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { DotBar, DotStack } from "./NothingAesthetic";

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

function emptyRunDay(date: string): DashboardRunActivityDay {
  return { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
}

const runSegmentColors = {
  succeeded: "var(--dashboard-positive)",
  recovered: "var(--dashboard-warning)",
  failed: "var(--dashboard-danger)",
  other: "var(--dashboard-neutral)",
} as const;

// Compact per-day tooltip that also attributes failures to their error class.
function runDayTooltip(entry: DashboardRunActivityDay): string {
  const lines = [`${entry.date}: ${entry.total} run${entry.total === 1 ? "" : "s"}`];
  if (entry.succeeded > 0) lines.push(`  succeeded: ${entry.succeeded}`);
  if (entry.recovered > 0) lines.push(`  recovered: ${entry.recovered} (retry succeeded)`);
  if (entry.failed > 0) {
    lines.push(`  failed: ${entry.failed}`);
    const codes = Object.entries(entry.failedByErrorCode ?? {}).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of codes) lines.push(`    ${code}: ${count}`);
  }
  if (entry.other > 0) lines.push(`  other: ${entry.other}`);
  return lines.join("\n");
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-(--sz-3px) mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(i === 0 || i === 6 || i === 13) ? (
            <span className="text-(length:--text-nano) text-muted-foreground tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export const chartSemanticColors = {
  success: "var(--dashboard-positive)",
  warning: "var(--dashboard-warning)",
  review: "var(--dashboard-neutral-strong)",
  info: "var(--dashboard-neutral-strong)",
  high: "var(--dashboard-warning)",
  danger: "var(--dashboard-danger)",
  cancelled: "var(--dashboard-neutral)",
  backlog: "var(--dashboard-neutral)",
  other: "var(--dashboard-neutral)",
} as const;

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="dashboard-chart-legend">
      {items.map(item => (
        <span key={item.label} className="dashboard-chart-legend-item">
          <span className="dashboard-chart-swatch" style={{ backgroundColor: item.color }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="dashboard-chart-card dashboard-surface dashboard-surface-dotted rounded-md border p-4 space-y-3">
      <div>
        <h3 className="dashboard-chart-title">{title}</h3>
        {subtitle && <span className="dashboard-chart-subtitle">{subtitle}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ---- Chart Components ---- */

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never };

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, emptyRunDay(day));
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") {
      entry.succeeded++;
    } else if (run.status === "failed" || run.status === "timed_out") {
      // A flat run list has no retry-chain linkage, so recovery can't be derived
      // here (the company dashboard computes it server-side). Attribute the
      // failure to its error class so the breakdown still renders.
      entry.failed++;
      const code = run.errorCode && run.errorCode.length > 0 ? run.errorCode : "unknown";
      entry.failedByErrorCode[code] = (entry.failedByErrorCode[code] ?? 0) + 1;
    } else {
      entry.other++;
    }
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const hasRecovered = activity.some(v => v.recovered > 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  const legendItems = [
    { color: runSegmentColors.succeeded, label: "Succeeded" },
    ...(hasRecovered ? [{ color: runSegmentColors.recovered, label: "Recovered" }] : []),
    { color: runSegmentColors.failed, label: "Failed" },
    { color: runSegmentColors.other, label: "Other" },
  ];

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={runDayTooltip(entry)}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div style={{ flex: entry.succeeded, backgroundColor: runSegmentColors.succeeded }} />}
                  {entry.recovered > 0 && <div style={{ flex: entry.recovered, backgroundColor: runSegmentColors.recovered }} />}
                  {entry.failed > 0 && <div style={{ flex: entry.failed, backgroundColor: runSegmentColors.failed }} />}
                  {entry.other > 0 && <div style={{ flex: entry.other, backgroundColor: runSegmentColors.other }} />}
                </div>
              ) : (
                <div className="mx-auto h-1.5 w-1.5 rounded-full bg-muted/50" />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={legendItems} />
    </div>
  );
}

const priorityColors: Record<string, string> = {
  critical: "var(--dashboard-danger)",
  high: "var(--dashboard-warning)",
  medium: "var(--dashboard-neutral-strong)",
  low: "var(--dashboard-neutral)",
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

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  <DotStack
                    title={`${day}: ${total} issues`}
                    values={priorityOrder.map((priority) => ({
                        key: priority,
                        value: entry[priority],
                        color: priorityColors[priority],
                      }))}
                  />
                </div>
              ) : (
                <div className="mx-auto h-1.5 w-1.5 rounded-full bg-muted/50" />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
    </div>
  );
}

// Dashboard status colors use the shared dashboard semantic roles. Status
// meaning remains in the labels and status icons; dashboard chrome stays
// neutral/monochrome unless a color communicates attention, failure, or
// successful completion. Priority and success-rate series use the same roles.
const statusColors: Record<string, string> = {
  todo: "var(--dashboard-warning)",
  in_progress: "var(--dashboard-accent)",
  in_review: "var(--dashboard-neutral-strong)",
  done: "var(--dashboard-positive)",
  blocked: "var(--dashboard-danger)",
  cancelled: "var(--dashboard-neutral)",
  backlog: "var(--dashboard-neutral)",
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

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day)!;
          const total = Object.values(entry).reduce((a, b) => a + b, 0);
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div
                  className="flex flex-col-reverse gap-px overflow-hidden rounded-sm"
                  style={{ height: `${heightPct}%`, minHeight: 2 }}
                >
                  {statusOrder.map((status) => {
                    const value = entry[status] ?? 0;
                    if (value <= 0) return null;
                    return (
                      <span
                        key={status}
                        data-status-segment={status}
                        className="block w-full min-h-px"
                        style={{
                          height: `${Math.max(8, (value / total) * 100)}%`,
                          backgroundColor: statusColors[status] ?? "var(--dashboard-neutral)",
                        }}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="mx-auto h-1.5 w-1.5 rounded-full bg-muted/50" />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "var(--dashboard-neutral)", label: statusLabels[s] ?? s }))} />
    </div>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          // Recovered runs ultimately succeeded, so they count toward the rate
          // rather than dragging it down as failures.
          const effectiveSucceeded = entry.succeeded + entry.recovered;
          const rate = entry.total > 0 ? effectiveSucceeded / entry.total : 0;
          const tone = entry.total === 0 ? "muted" : rate >= 0.8 ? "success" : rate >= 0.5 ? "warning" : "danger";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${effectiveSucceeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <DotBar heightPct={rate * 100} tone={tone} />
              ) : (
                <div className="mx-auto h-1.5 w-1.5 rounded-full bg-muted/50" />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}
