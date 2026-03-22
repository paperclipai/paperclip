import { Link } from "@/lib/router";
import { Clock } from "lucide-react";
import { StatusBadge } from "../../components/StatusBadge";
import { MarkdownBody } from "../../components/MarkdownBody";
import { EntityRow } from "../../components/EntityRow";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../../components/ActivityCharts";
import { formatCents, formatDate, relativeTime, formatTokens } from "../../lib/utils";
import { cn } from "../../lib/utils";
import { runStatusIcons, sourceLabels, runMetrics } from "./utils";
import type { AgentDetail as AgentDetailRecord, HeartbeatRun, AgentRuntimeState } from "@paperclipai/shared";

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function LatestRunCard({ runs, agentId }: { runs: HeartbeatRun[]; agentId: string }) {
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  const liveRun = sorted.find((r) => r.status === "running" || r.status === "queued");
  const run = liveRun ?? sorted[0];
  const isLive = run.status === "running" || run.status === "queued";
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";

  return (
    <div className="space-y-3">
      <div className="flex w-full items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {isLive && (
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
          )}
          {isLive ? "Live Run" : "Latest Run"}
        </h3>
        <Link
          to={`/agents/${agentId}/runs/${run.id}`}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
        >
          View details &rarr;
        </Link>
      </div>

      <Link
        to={`/agents/${agentId}/runs/${run.id}`}
        className={cn(
          "block border rounded-lg p-4 space-y-2 w-full no-underline transition-colors hover:bg-muted/50 cursor-pointer",
          isLive ? "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.08)]" : "border-border"
        )}
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={cn("h-3.5 w-3.5", statusInfo.color, run.status === "running" && "animate-spin")} />
          <StatusBadge status={run.status} />
          <span className="font-mono text-xs text-muted-foreground">{run.id.slice(0, 8)}</span>
          <span className={cn(
            "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            run.invocationSource === "timer" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
              : run.invocationSource === "assignment" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
              : run.invocationSource === "on_demand" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"
              : "bg-muted text-muted-foreground"
          )}>
            {sourceLabels[run.invocationSource] ?? run.invocationSource}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{relativeTime(run.createdAt)}</span>
        </div>

        {summary && (
          <div className="overflow-hidden max-h-16">
            <MarkdownBody className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{summary}</MarkdownBody>
          </div>
        )}
      </Link>
    </div>
  );
}

function CostsSection({
  runtimeState,
  runs,
}: {
  runtimeState?: AgentRuntimeState;
  runs: HeartbeatRun[];
}) {
  const runsWithCost = runs
    .filter((r) => {
      const metrics = runMetrics(r);
      return metrics.cost > 0 || metrics.input > 0 || metrics.output > 0 || metrics.cached > 0;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4">
      {runtimeState && (
        <div className="border border-border rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
            <div>
              <span className="text-xs text-muted-foreground block">Input tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Output tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalOutputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Cached tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalCachedInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Total cost</span>
              <span className="text-lg font-semibold">{formatCents(runtimeState.totalCostCents)}</span>
            </div>
          </div>
        </div>
      )}
      {runsWithCost.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-accent/20">
                <th scope="col" className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                <th scope="col" className="text-left px-3 py-2 font-medium text-muted-foreground">Run</th>
                <th scope="col" className="text-right px-3 py-2 font-medium text-muted-foreground">Input</th>
                <th scope="col" className="text-right px-3 py-2 font-medium text-muted-foreground">Output</th>
                <th scope="col" className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runsWithCost.slice(0, 10).map((run) => {
                const metrics = runMetrics(run);
                return (
                  <tr key={run.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">{formatDate(run.createdAt)}</td>
                    <td className="px-3 py-2 font-mono">{run.id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(metrics.input)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatTokens(metrics.output)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {metrics.cost > 0
                        ? `$${metrics.cost.toFixed(4)}`
                        : "-"
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function AgentOverview({
  agent,
  runs,
  assignedIssues,
  runtimeState,
  agentId,
  agentRouteId,
}: {
  agent: AgentDetailRecord;
  runs: HeartbeatRun[];
  assignedIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  runtimeState?: AgentRuntimeState;
  agentId: string;
  agentRouteId: string;
}) {
  return (
    <div className="space-y-8">
      {/* Latest Run */}
      <LatestRunCard runs={runs} agentId={agentRouteId} />

      {/* Charts */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ChartCard title="Run Activity" subtitle="Last 14 days">
          <RunActivityChart runs={runs} />
        </ChartCard>
        <ChartCard title="Issues by Priority" subtitle="Last 14 days">
          <PriorityChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Issues by Status" subtitle="Last 14 days">
          <IssueStatusChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle="Last 14 days">
          <SuccessRateChart runs={runs} />
        </ChartCard>
      </div>

      {/* Recent Issues */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Issues</h3>
          <Link to={`/issues?assignee=${agentId}`} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assigned issues.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedIssues.slice(0, 10).map((issue) => (
              <EntityRow
                key={issue.id}
                identifier={issue.identifier ?? issue.id.slice(0, 8)}
                title={issue.title}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={<StatusBadge status={issue.status} />}
              />
            ))}
            {assignedIssues.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedIssues.length - 10} more issues
              </div>
            )}
          </div>
        )}
      </div>

      {/* Costs */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Costs</h3>
        <CostsSection runtimeState={runtimeState} runs={runs} />
      </div>
    </div>
  );
}
