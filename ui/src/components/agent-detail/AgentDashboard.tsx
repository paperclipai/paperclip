import { useState } from "react";
import { Link } from "@/lib/router";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../ActivityCharts";
import { StatusBadge } from "../StatusBadge";
import { EmploymentBadge } from "../EmploymentBadge";
import { MarkdownBody } from "../MarkdownBody";
import { EntityRow } from "../EntityRow";
import { Button } from "@/components/ui/button";
import { formatCents, formatTokens, formatDate, relativeTime, cn } from "../../lib/utils";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { Clock, AlertTriangle, CheckCircle2, Circle } from "lucide-react";
import {
  DEPARTMENT_LABELS,
  TERMINATION_REASONS,
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type Department,
  type TerminationReason,
} from "@ironworksai/shared";
import type {
  AgentDetail as AgentDetailRecord,
  HeartbeatRun,
  AgentRuntimeState,
} from "@ironworksai/shared";
import { runStatusIcons, runMetrics, sourceLabels } from "./agent-detail-utils";

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
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Run</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Input</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Output</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
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

// ── Onboarding Checklist ─────────────────────────────────────────────────────

function OnboardingChecklist({
  agent,
  assignedIssues,
  runs,
}: {
  agent: AgentDetailRecord;
  assignedIssues: { id: string; status: string }[];
  runs: HeartbeatRun[];
}) {
  const ext = agent as unknown as Record<string, unknown>;
  const hiredAt = ext.hiredAt as string | null;
  if (!hiredAt) return null;
  const ageMs = Date.now() - new Date(hiredAt).getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (ageMs > sevenDaysMs) return null;

  const hasPermissionGrants = (agent.access?.grants?.length ?? 0) > 0;
  const hasAdapterConfig =
    agent.adapterConfig != null &&
    Object.keys(agent.adapterConfig).length > 0;
  const hasCompletedIssue = assignedIssues.some((i) => i.status === "done");
  // Workspace folders: inferred from runs that produced workspace operations or any run succeeded
  const hasSucceededRun = runs.some((r) => r.status === "succeeded");

  const items: Array<{ label: string; done: boolean }> = [
    { label: "Data access provisioned", done: hasPermissionGrants },
    { label: "Tools assigned", done: hasAdapterConfig },
    { label: "First run completed", done: hasSucceededRun },
    { label: "Knowledge base seeded", done: hasCompletedIssue },
  ];

  const allDone = items.every((i) => i.done);

  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Onboarding Status
        </h3>
        {allDone && (
          <span className="text-xs text-emerald-500 font-medium">Complete</span>
        )}
      </div>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2 text-sm">
            {item.done ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            )}
            <span className={item.done ? "text-foreground" : "text-muted-foreground"}>
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Employment Card ───────────────────────────────────────────────────────────

function EmploymentCard({
  agent,
  companyId,
}: {
  agent: AgentDetailRecord;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [showTerminateConfirm, setShowTerminateConfirm] = useState(false);
  const [terminationReason, setTerminationReason] = useState<string>("manual");
  const ext = agent as unknown as Record<string, unknown>;
  const employmentType = (ext.employmentType as string) ?? "full_time";
  const department = ext.department as string | null;
  const hiredAt = ext.hiredAt as string | null;
  const performanceScore = ext.performanceScore as number | null;
  const contractEndCondition = ext.contractEndCondition as string | null;
  const contractEndAt = ext.contractEndAt as string | null;
  const contractBudgetCents = ext.contractBudgetCents as number | null;
  const autonomyLevel = (ext.autonomyLevel as AutonomyLevel | null) ?? null;
  const autonomyInfo = autonomyLevel
    ? AUTONOMY_LEVELS.find((l) => l.key === autonomyLevel) ?? null
    : null;

  const terminateMutation = useMutation({
    mutationFn: () => agentsApi.terminateWithReason(companyId, agent.id, terminationReason),
    onSuccess: () => {
      setShowTerminateConfirm(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });

  // Show ramp time for agents hired within the last 30 days
  const isRecentHire = hiredAt
    ? Date.now() - new Date(hiredAt).getTime() < 30 * 24 * 60 * 60 * 1000
    : false;
  const onboardingMetricsQuery = useQuery({
    queryKey: ["agents", agent.id, "onboarding-metrics"],
    queryFn: () => agentsApi.onboardingMetrics(agent.id, companyId),
    enabled: isRecentHire,
  });

  const reasonLabels: Record<string, string> = {
    contract_complete: "Contract Complete",
    budget_exhausted: "Budget Exhausted",
    deadline_reached: "Deadline Reached",
    manual: "Manual Termination",
    performance: "Performance",
  };

  return (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Employment</h3>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-xs text-muted-foreground block">Type</span>
          <EmploymentBadge type={employmentType} className="mt-1" />
        </div>
        {department && (
          <div>
            <span className="text-xs text-muted-foreground block">Department</span>
            <span className="text-sm font-medium mt-1 block">
              {(DEPARTMENT_LABELS as Record<string, string>)[department] ?? department}
            </span>
          </div>
        )}
        {hiredAt && (
          <div>
            <span className="text-xs text-muted-foreground block">Hired</span>
            <span className="text-sm mt-1 block">{formatDate(hiredAt)}</span>
          </div>
        )}
        {isRecentHire && onboardingMetricsQuery.data && (
          <div>
            <span className="text-xs text-muted-foreground block">Ramp time</span>
            <span className="text-sm mt-1 block">
              {onboardingMetricsQuery.data.rampTimeDays !== null
                ? `${onboardingMetricsQuery.data.rampTimeDays} days`
                : "Not yet completed first issue"}
            </span>
          </div>
        )}
        {autonomyInfo && (
          <div className="col-span-2">
            <span className="text-xs text-muted-foreground block">Autonomy Level</span>
            <div className="mt-1 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                {autonomyInfo.key.toUpperCase()} - {autonomyInfo.label}
              </span>
              <span className="text-xs text-muted-foreground">{autonomyInfo.description}</span>
            </div>
          </div>
        )}
        {performanceScore != null && (
          <div>
            <span className="text-xs text-muted-foreground block">Performance</span>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    performanceScore >= 80 ? "bg-emerald-500" : performanceScore >= 50 ? "bg-amber-500" : "bg-red-500",
                  )}
                  style={{ width: `${performanceScore}%` }}
                />
              </div>
              <span className="text-xs tabular-nums">{performanceScore}/100</span>
            </div>
          </div>
        )}
      </div>

      {employmentType === "contractor" && (
        <div className="border-t border-border pt-3 space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Contract Details</h4>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {contractEndCondition && (
              <div>
                <span className="text-xs text-muted-foreground block">End Condition</span>
                <span className="capitalize">{contractEndCondition.replace(/_/g, " ")}</span>
              </div>
            )}
            {contractEndAt && (
              <div>
                <span className="text-xs text-muted-foreground block">Deadline</span>
                <span>{formatDate(contractEndAt)}</span>
              </div>
            )}
            {contractBudgetCents != null && (
              <div>
                <span className="text-xs text-muted-foreground block">Budget Remaining</span>
                <span>{formatCents(contractBudgetCents)}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {agent.status !== "terminated" && (
        <div className="border-t border-border pt-3">
          {!showTerminateConfirm ? (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setShowTerminateConfirm(true)}
            >
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
              {employmentType === "full_time" ? "Decommission Agent" : "Terminate Agent"}
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">
                The following actions will occur on {employmentType === "full_time" ? "decommission" : "termination"}:
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li className="flex items-start gap-1.5">
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                  Memory entries will be archived
                </li>
                {employmentType === "contractor" && (
                  <li className="flex items-start gap-1.5">
                    <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                    Workspace will be archived
                  </li>
                )}
                <li className="flex items-start gap-1.5">
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                  Active issues will be unassigned
                </li>
                <li className="flex items-start gap-1.5">
                  <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-muted-foreground/50 shrink-0" />
                  A termination record will be created
                </li>
              </ul>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Reason</label>
                <select
                  value={terminationReason}
                  onChange={(e) => setTerminationReason(e.target.value)}
                  className="w-full text-xs bg-transparent border border-border rounded px-2 py-1.5"
                >
                  {TERMINATION_REASONS.map((r) => (
                    <option key={r} value={r}>{reasonLabels[r] ?? r}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => terminateMutation.mutate()}
                  disabled={terminateMutation.isPending}
                >
                  {terminateMutation.isPending
                    ? "Processing..."
                    : employmentType === "full_time"
                    ? "Confirm Decommission"
                    : "Confirm Terminate"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTerminateConfirm(false)}
                  disabled={terminateMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
              {terminateMutation.isError && (
                <p className="text-xs text-destructive">
                  {terminateMutation.error instanceof Error ? terminateMutation.error.message : "Termination failed"}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentDashboard({
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
      {/* Onboarding Status - only shown for newly hired agents */}
      <OnboardingChecklist agent={agent} assignedIssues={assignedIssues} runs={runs} />

      {/* Employment */}
      <EmploymentCard agent={agent} companyId={agent.companyId} />

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
          <Link
            to={`/issues?participantAgentId=${agentId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent issues.</p>
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
