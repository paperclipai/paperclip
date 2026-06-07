import type { DashboardIssueActivityDay, DashboardRunActivityDay, HeartbeatRun } from "@paperclipai/shared";

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

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
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

function ChartA11yFrame({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <div role="img" aria-label={`${label}. ${summary}`}>
      <div aria-hidden="true">{children}</div>
      <p className="sr-only">{summary}</p>
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

/* ---- Chart Components ---- */

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

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const totals = activity.reduce(
    (acc, day) => ({
      succeeded: acc.succeeded + day.succeeded,
      failed: acc.failed + day.failed,
      other: acc.other + day.other,
      total: acc.total + day.total,
    }),
    { succeeded: 0, failed: 0, other: 0, total: 0 },
  );

  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <ChartA11yFrame
      label="Run activity for the last 14 days"
      summary={`${totals.total} runs: ${totals.succeeded} succeeded, ${totals.failed} failed, ${totals.other} other.`}
    >
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? { date: day, succeeded: 0, failed: 0, other: 0, total: 0 };
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} runs`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div className="bg-emerald-500" style={{ flex: entry.succeeded }} />}
                  {entry.failed > 0 && <div className="bg-red-500" style={{ flex: entry.failed }} />}
                  {entry.other > 0 && <div className="bg-neutral-500" style={{ flex: entry.other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </ChartA11yFrame>
  );
}

const priorityColors: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
};

const priorityOrder = ["critical", "high", "medium", "low"] as const;

type IssueChartProps =
  | { activity?: DashboardIssueActivityDay[] | null; issues?: never }
  | { issues?: { priority: string; status?: string; createdAt: Date | string }[] | null; activity?: never };

function newIssueActivityBucket(date: string): DashboardIssueActivityDay {
  return {
    date,
    byPriority: { critical: 0, high: 0, medium: 0, low: 0 },
    byStatus: { backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0 },
    total: 0,
  };
}

function aggregateIssues(issues: readonly { priority?: string; status?: string; createdAt: Date | string }[] = []): DashboardIssueActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map(days.map((day) => [day, newIssueActivityBucket(day)]));
  for (const issue of issues) {
    const day = new Date(issue.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (issue.priority && priorityOrder.includes(issue.priority as typeof priorityOrder[number])) {
      entry.byPriority[issue.priority as typeof priorityOrder[number]]++;
    }
    if (issue.status && statusOrderAll.includes(issue.status as typeof statusOrderAll[number])) {
      const status = issue.status as typeof statusOrderAll[number];
      entry.byStatus[status]++;
    }
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveIssueActivity(props: IssueChartProps): DashboardIssueActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.issues)) return aggregateIssues(props.issues);
  return [];
}

export function PriorityChart(props: IssueChartProps) {
  const activity = resolveIssueActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const totals = activity.reduce(
    (acc, day) => {
      for (const priority of priorityOrder) acc[priority] += day.byPriority[priority];
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
  const totalIssues = Object.values(totals).reduce((sum, count) => sum + count, 0);

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <ChartA11yFrame
      label="Issues by priority for the last 14 days"
      summary={`${totalIssues} issues: ${totals.critical} critical, ${totals.high} high, ${totals.medium} medium, ${totals.low} low.`}
    >
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? newIssueActivityBucket(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {priorityOrder.map(p => entry.byPriority[p] > 0 ? (
                    <div key={p} style={{ flex: entry.byPriority[p], backgroundColor: priorityColors[p] }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={priorityOrder.map(p => ({ color: priorityColors[p], label: p.charAt(0).toUpperCase() + p.slice(1) }))} />
    </ChartA11yFrame>
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

const statusOrderAll = ["todo", "in_progress", "in_review", "done", "blocked", "cancelled", "backlog"] as const;

export function IssueStatusChart(props: IssueChartProps) {
  const activity = resolveIssueActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));
  const allStatuses = new Set<string>();
  for (const day of activity) {
    for (const status of statusOrderAll) {
      if (day.byStatus[status] > 0) allStatuses.add(status);
    }
  }

  const statusOrder = statusOrderAll.filter(s => allStatuses.has(s));
  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = allStatuses.size > 0;
  const totals = activity.reduce<Record<string, number>>((acc, day) => {
    for (const status of statusOrderAll) acc[status] = (acc[status] ?? 0) + day.byStatus[status];
    return acc;
  }, {});
  const totalIssues = Object.values(totals).reduce((sum, count) => sum + count, 0);
  const summary = statusOrder
    .map((status) => `${totals[status] ?? 0} ${statusLabels[status] ?? status}`)
    .join(", ");

  if (!hasData) return <p className="text-xs text-muted-foreground">No tasks</p>;

  return (
    <ChartA11yFrame
      label="Issues by status for the last 14 days"
      summary={`${totalIssues} issues: ${summary}.`}
    >
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? newIssueActivityBucket(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${total} issues`}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {statusOrder.map(s => entry.byStatus[s] > 0 ? (
                    <div key={s} style={{ flex: entry.byStatus[s], backgroundColor: statusColors[s] ?? "#6b7280" }} />
                  ) : null)}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={statusOrder.map(s => ({ color: statusColors[s] ?? "#6b7280", label: statusLabels[s] ?? s }))} />
    </ChartA11yFrame>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  const totals = activity.reduce(
    (acc, day) => ({ succeeded: acc.succeeded + day.succeeded, total: acc.total + day.total }),
    { succeeded: 0, total: 0 },
  );
  const overallRate = totals.total > 0 ? Math.round((totals.succeeded / totals.total) * 100) : 0;
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <ChartA11yFrame
      label="Run success rate for the last 14 days"
      summary={`${overallRate}% success rate, ${totals.succeeded} of ${totals.total} runs succeeded.`}
    >
      <div className="flex items-end gap-[3px] h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? { date: day, succeeded: 0, failed: 0, other: 0, total: 0 };
          const rate = entry.total > 0 ? entry.succeeded / entry.total : 0;
          const color = entry.total === 0 ? undefined : rate >= 0.8 ? "#10b981" : rate >= 0.5 ? "#eab308" : "#ef4444";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${entry.succeeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </ChartA11yFrame>
  );
}
