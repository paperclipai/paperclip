import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi, type AgentHeartbeatStats, type DailyStats } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { ChartCard } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { Activity, AlertTriangle, CheckCircle, Clock, XCircle, Zap, Timer } from "lucide-react";

function formatDuration(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = Math.round(seconds % 60);
  return `${minutes}m ${remainingSec}s`;
}

function statusColor(status: string | null): string {
  if (!status) return "text-muted-foreground";
  if (status === "succeeded") return "text-emerald-500";
  if (status === "failed" || status === "timed_out") return "text-red-500";
  if (status === "running") return "text-blue-500";
  return "text-muted-foreground";
}

function StatusDot({ status }: { status: string | null }) {
  const color =
    status === "succeeded"
      ? "bg-emerald-500"
      : status === "failed" || status === "timed_out"
        ? "bg-red-500"
        : status === "running"
          ? "bg-blue-500"
          : "bg-muted-foreground/50";
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", color)} />;
}

/* ---- Daily Charts ---- */

function DailyRunChart({ dailyStats, periodDays }: { dailyStats: DailyStats[]; periodDays: number }) {
  const days = generateDayLabels(periodDays);
  const statsMap = new Map(dailyStats.map((d) => [d.date, d]));
  const maxValue = Math.max(
    ...days.map((day) => {
      const s = statsMap.get(day);
      return s ? s.succeeded + s.failed + s.timedOut + s.other : 0;
    }),
    1,
  );

  const hasData = dailyStats.length > 0;
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-24">
        {days.map((day) => {
          const s = statsMap.get(day);
          const succeeded = s?.succeeded ?? 0;
          const failed = (s?.failed ?? 0) + (s?.timedOut ?? 0);
          const other = s?.other ?? 0;
          const total = succeeded + failed + other;
          const heightPct = (total / maxValue) * 100;
          return (
            <div
              key={day}
              className="flex-1 h-full flex flex-col justify-end"
              title={`${day}: ${total} runs (${succeeded} ok, ${failed} failed)`}
            >
              {total > 0 ? (
                <div
                  className="flex flex-col-reverse gap-px overflow-hidden"
                  style={{ height: `${heightPct}%`, minHeight: 2 }}
                >
                  {succeeded > 0 && <div className="bg-emerald-500" style={{ flex: succeeded }} />}
                  {failed > 0 && <div className="bg-red-500" style={{ flex: failed }} />}
                  {other > 0 && <div className="bg-neutral-500" style={{ flex: other }} />}
                </div>
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DayLabels days={days} />
      <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
        {[
          { color: "#10b981", label: "Succeeded" },
          { color: "#ef4444", label: "Failed" },
          { color: "#737373", label: "Other" },
        ].map((item) => (
          <span key={item.label} className="flex items-center gap-1 text-[9px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function DailyDurationChart({ dailyStats, periodDays }: { dailyStats: DailyStats[]; periodDays: number }) {
  const days = generateDayLabels(periodDays);
  const statsMap = new Map(dailyStats.map((d) => [d.date, d]));
  const maxDuration = Math.max(...days.map((day) => statsMap.get(day)?.avgDurationMs ?? 0), 1);
  const hasData = dailyStats.some((d) => d.avgDurationMs != null);
  if (!hasData) return <p className="text-xs text-muted-foreground">No duration data</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-24">
        {days.map((day) => {
          const dur = statsMap.get(day)?.avgDurationMs ?? 0;
          const heightPct = (dur / maxDuration) * 100;
          return (
            <div
              key={day}
              className="flex-1 h-full flex flex-col justify-end"
              title={`${day}: avg ${formatDuration(dur || null)}`}
            >
              {dur > 0 ? (
                <div className="bg-blue-500" style={{ height: `${heightPct}%`, minHeight: 2 }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DayLabels days={days} />
    </div>
  );
}

function DailySuccessRateChart({ dailyStats, periodDays }: { dailyStats: DailyStats[]; periodDays: number }) {
  const days = generateDayLabels(periodDays);
  const statsMap = new Map(dailyStats.map((d) => [d.date, d]));
  const hasData = dailyStats.length > 0;
  if (!hasData) return <p className="text-xs text-muted-foreground">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-[3px] h-24">
        {days.map((day) => {
          const s = statsMap.get(day);
          const total = s ? s.succeeded + s.failed + s.timedOut + s.other : 0;
          const rate = total > 0 ? s!.succeeded / total : 0;
          const color = total === 0 ? undefined : rate >= 0.8 ? "#10b981" : rate >= 0.5 ? "#eab308" : "#ef4444";
          return (
            <div
              key={day}
              className="flex-1 h-full flex flex-col justify-end"
              title={`${day}: ${total > 0 ? Math.round(rate * 100) : 0}%`}
            >
              {total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-muted/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DayLabels days={days} />
    </div>
  );
}

function generateDayLabels(periodDays: number): string[] {
  return Array.from({ length: periodDays }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (periodDays - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

function DayLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-[3px] mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {i === 0 || i === Math.floor(days.length / 2) || i === days.length - 1 ? (
            <span className="text-[9px] text-muted-foreground tabular-nums">
              {`${new Date(day + "T12:00:00").getMonth() + 1}/${new Date(day + "T12:00:00").getDate()}`}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* ---- Agent Table ---- */

function AgentStatsTable({ agents }: { agents: AgentHeartbeatStats[] }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No agent data available.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs">Agent</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs text-right">Runs</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs text-right">Success</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs text-right">Failed</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs text-right">Rate</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs text-right">Avg Duration</th>
            <th className="py-2 pr-4 font-medium text-muted-foreground text-xs">Last Run</th>
            <th className="py-2 font-medium text-muted-foreground text-xs">Status</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr
              key={agent.agentId}
              className={cn(
                "border-b border-border/50 hover:bg-accent/30 transition-colors",
                agent.isStuck && "bg-red-500/5",
              )}
            >
              <td className="py-2.5 pr-4">
                <Link to={`/agents/${agent.agentId}`} className="font-medium hover:underline">
                  {agent.agentName}
                </Link>
                <div className="text-xs text-muted-foreground">{agent.adapterType}</div>
              </td>
              <td className="py-2.5 pr-4 text-right tabular-nums">{agent.totalRuns}</td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-emerald-500">{agent.succeededRuns}</td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-red-500">
                {agent.failedRuns + agent.timedOutRuns}
              </td>
              <td className="py-2.5 pr-4 text-right">
                <span
                  className={cn(
                    "tabular-nums font-medium",
                    agent.successRate >= 80
                      ? "text-emerald-500"
                      : agent.successRate >= 50
                        ? "text-yellow-500"
                        : "text-red-500",
                  )}
                >
                  {agent.successRate}%
                </span>
              </td>
              <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
                {formatDuration(agent.avgDurationMs)}
              </td>
              <td className="py-2.5 pr-4 text-muted-foreground text-xs">
                {agent.lastRunAt ? timeAgo(agent.lastRunAt) : "-"}
              </td>
              <td className="py-2.5">
                <div className="flex items-center gap-1.5">
                  <StatusDot status={agent.lastRunStatus} />
                  {agent.isStuck && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-500">
                      <AlertTriangle className="h-3 w-3" />
                      Stuck
                    </span>
                  )}
                  {agent.consecutiveFailures > 0 && !agent.isStuck && (
                    <span className="text-[10px] text-red-400">{agent.consecutiveFailures}x fail</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---- Stuck Agents Alert ---- */

function StuckAgentsAlert({ agents }: { agents: AgentHeartbeatStats[] }) {
  const stuckAgents = agents.filter((a) => a.isStuck);
  if (stuckAgents.length === 0) return null;

  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div>
          <p className="text-sm font-medium text-red-500">
            {stuckAgents.length} stuck agent{stuckAgents.length !== 1 ? "s" : ""} detected
          </p>
          <ul className="mt-1.5 space-y-1">
            {stuckAgents.map((agent) => (
              <li key={agent.agentId} className="text-xs text-muted-foreground">
                <Link to={`/agents/${agent.agentId}`} className="font-medium hover:underline text-foreground">
                  {agent.agentName}
                </Link>{" "}
                {agent.consecutiveFailures >= 3
                  ? `${agent.consecutiveFailures} consecutive failures`
                  : "run appears stuck (>30min)"}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ---- Main Page ---- */

export function HeartbeatMonitoring() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [periodDays, setPeriodDays] = useState(14);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard", href: "/dashboard" }, { label: "Heartbeat Monitoring" }]);
  }, [setBreadcrumbs]);

  const {
    data: stats,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.heartbeatStats(selectedCompanyId!, periodDays),
    queryFn: () => heartbeatsApi.stats(selectedCompanyId!, periodDays),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Select a company to view heartbeat monitoring." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error) {
    return <p className="text-sm text-destructive p-4">{error.message}</p>;
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Heartbeat Monitoring</h2>
        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5">
          {[7, 14, 30].map((days) => (
            <button
              key={days}
              onClick={() => setPeriodDays(days)}
              className={cn(
                "px-3 py-1 text-xs rounded-sm transition-colors",
                periodDays === days
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {/* Stuck agents alert */}
      <StuckAgentsAlert agents={stats.agents} />

      {/* Summary metrics */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
        <MetricCard
          icon={Zap}
          value={stats.totalRuns}
          label="Total Runs"
          description={
            <span>
              {stats.succeededRuns} succeeded, {stats.failedRuns} failed
            </span>
          }
        />
        <MetricCard
          icon={CheckCircle}
          value={`${stats.overallSuccessRate}%`}
          label="Success Rate"
          description={
            <span
              className={
                stats.overallSuccessRate >= 80
                  ? "text-emerald-500"
                  : stats.overallSuccessRate >= 50
                    ? "text-yellow-500"
                    : "text-red-500"
              }
            >
              Last {periodDays} days
            </span>
          }
        />
        <MetricCard
          icon={Timer}
          value={formatDuration(stats.avgDurationMs)}
          label="Avg Duration"
          description={<span>Per heartbeat run</span>}
        />
        <MetricCard
          icon={AlertTriangle}
          value={stats.stuckAgentCount}
          label="Stuck Agents"
          description={
            <span className={stats.stuckAgentCount > 0 ? "text-red-500" : "text-emerald-500"}>
              {stats.stuckAgentCount > 0 ? "Needs attention" : "All healthy"}
            </span>
          }
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <ChartCard title="Run Activity" subtitle={`Last ${periodDays} days`}>
          <DailyRunChart dailyStats={stats.dailyStats} periodDays={periodDays} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle={`Last ${periodDays} days`}>
          <DailySuccessRateChart dailyStats={stats.dailyStats} periodDays={periodDays} />
        </ChartCard>
        <ChartCard title="Avg Duration" subtitle={`Last ${periodDays} days`}>
          <DailyDurationChart dailyStats={stats.dailyStats} periodDays={periodDays} />
        </ChartCard>
      </div>

      {/* Agent breakdown table */}
      <div className="border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Agent Breakdown</h3>
        <AgentStatsTable agents={stats.agents} />
      </div>
    </div>
  );
}
