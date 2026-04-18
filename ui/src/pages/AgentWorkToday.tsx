import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { Identity } from "../components/Identity";
import { StatusIcon } from "../components/StatusIcon";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents, formatTokens } from "../lib/utils";
import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  XCircle,
  Zap,
} from "lucide-react";
import type { Agent, HeartbeatRun, Issue } from "@paperclipai/shared";

/* ------------------------------------------------------------------ */
/*  Shared helpers (same logic as Dashboard)                           */
/* ------------------------------------------------------------------ */

function extractRunSummary(run: HeartbeatRun): string {
  const result = run.resultJson;
  if (!result) return "";
  return String(result.summary ?? result.result ?? "").trim();
}

function isToday(date: Date | string): boolean {
  const d = new Date(date);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function extractUsage(run: HeartbeatRun): { input: number; output: number; costCents: number } {
  const usage = run.usageJson as Record<string, unknown> | null;
  if (!usage) return { input: 0, output: 0, costCents: 0 };
  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const costCents = Number(usage.totalCostCents ?? usage.total_cost_cents ?? 0);
  return { input, output, costCents };
}

function defaultSummary(run: HeartbeatRun): string {
  if (run.status === "failed") return run.error ?? "Run failed";
  if (run.status === "cancelled") return "Cancelled by operator";
  if (run.status === "timed_out") return "Run exceeded time limit";
  if (run.status === "running") return "Currently running…";
  if (run.status === "queued") return "Waiting to start…";
  return "Completed";
}

type RunStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "running" | "queued";

interface WorkRun {
  id: string;
  status: RunStatus;
  summary: string;
  timestamp: string;
  issueId: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

interface WorkGroup {
  agentId: string;
  agentName: string;
  agentRole: string | null;
  runs: WorkRun[];
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  active: number;
  totalTokens: number;
  totalCostCents: number;
}

function groupRunsByAgent(runs: HeartbeatRun[], agentMap: Map<string, Agent>): WorkGroup[] {
  const relevantRuns = runs.filter((r) => {
    if (r.status === "running" || r.status === "queued") return true;
    const ts = r.finishedAt ?? r.createdAt;
    return ts && isToday(ts);
  }).sort((a, b) => {
    const aActive = a.status === "running" || a.status === "queued" ? 1 : 0;
    const bActive = b.status === "running" || b.status === "queued" ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return new Date(b.finishedAt ?? b.createdAt).getTime() - new Date(a.finishedAt ?? a.createdAt).getTime();
  });

  const grouped = new Map<string, WorkGroup>();

  for (const run of relevantRuns) {
    const summary = extractRunSummary(run);
    const context = run.contextSnapshot as Record<string, unknown> | null;
    const issueId = typeof context?.issueId === "string" ? context.issueId : null;
    const usage = extractUsage(run);

    let group = grouped.get(run.agentId);
    if (!group) {
      const agent = agentMap.get(run.agentId);
      group = {
        agentId: run.agentId,
        agentName: agent?.name ?? run.agentId.slice(0, 8),
        agentRole: agent?.title ?? agent?.role ?? null,
        runs: [],
        succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, active: 0,
        totalTokens: 0, totalCostCents: 0,
      };
      grouped.set(run.agentId, group);
    }

    if (run.status === "succeeded") group.succeeded += 1;
    else if (run.status === "failed") group.failed += 1;
    else if (run.status === "cancelled") group.cancelled += 1;
    else if (run.status === "timed_out") group.timedOut += 1;
    else group.active += 1;

    group.totalTokens += usage.input + usage.output;
    group.totalCostCents += usage.costCents;

    group.runs.push({
      id: run.id,
      status: run.status as RunStatus,
      summary: summary || defaultSummary(run),
      timestamp: String(run.finishedAt ?? run.createdAt),
      issueId,
      inputTokens: usage.input,
      outputTokens: usage.output,
      costCents: usage.costCents,
    });
  }

  return [...grouped.values()];
}

/* ------------------------------------------------------------------ */
/*  Full-page Agent Work Card (runs expanded by default)               */
/* ------------------------------------------------------------------ */

function FullAgentWorkCard({
  group,
  issueMap,
}: {
  group: WorkGroup;
  issueMap: Map<string, Issue>;
}) {
  const [expanded, setExpanded] = useState(true);

  const touchedIssues = useMemo(() => {
    const seen = new Set<string>();
    const result: Issue[] = [];
    for (const run of group.runs) {
      if (run.issueId && !seen.has(run.issueId)) {
        seen.add(run.issueId);
        const issue = issueMap.get(run.issueId);
        if (issue) result.push(issue);
      }
    }
    return result;
  }, [group.runs, issueMap]);

  return (
    <div className="rounded-md border border-border overflow-hidden">
      {/* Agent header */}
      <div className="flex items-center gap-3 bg-muted/30 px-4 py-3">
        <Identity name={group.agentName} size="default" />
        {group.agentRole && (
          <span className="text-xs text-muted-foreground">{group.agentRole}</span>
        )}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {group.totalTokens > 0 && (
            <span>{formatTokens(group.totalTokens)} tok</span>
          )}
          {group.totalCostCents > 0 && (
            <span>{formatCents(group.totalCostCents)}</span>
          )}
          <span className="flex items-center gap-1.5 flex-wrap">
            {group.active > 0 && (
              <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
                <Loader2 className="h-3 w-3 animate-spin" />{group.active} active
              </span>
            )}
            {group.succeeded > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400">{group.succeeded} succeeded</span>
            )}
            {group.failed > 0 && (
              <span className="text-red-600 dark:text-red-400">{group.failed} failed</span>
            )}
            {group.timedOut > 0 && (
              <span className="text-amber-600 dark:text-amber-400">{group.timedOut} timed out</span>
            )}
            {group.cancelled > 0 && (
              <span className="text-muted-foreground">{group.cancelled} cancelled</span>
            )}
          </span>
        </span>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {/* Issues touched */}
        {touchedIssues.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70 mr-1">Issues</span>
            {touchedIssues.map((issue) => (
              <Link
                key={issue.id}
                to={`/issues/${issue.identifier ?? issue.id}`}
                className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs no-underline text-inherit transition-colors hover:bg-accent"
              >
                <StatusIcon status={issue.status} />
                <span className="font-mono text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                <span className="max-w-[240px] truncate">{issue.title}</span>
              </Link>
            ))}
          </div>
        )}

        {/* Expandable runs */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {group.runs.length} run{group.runs.length === 1 ? "" : "s"}
        </button>
      </div>

      {/* Run list */}
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {group.runs.map((run) => {
            const issue = run.issueId ? issueMap.get(run.issueId) ?? null : null;
            const statusIcon = run.status === "succeeded"
              ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              : run.status === "failed"
                ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                : run.status === "running"
                  ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-500 animate-spin" />
                  : run.status === "queued"
                    ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    : run.status === "timed_out"
                      ? <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      : <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
            const textClass = run.status === "failed"
              ? "text-red-600 dark:text-red-400"
              : run.status === "running" || run.status === "queued"
                ? "text-cyan-700 dark:text-cyan-300"
                : run.status === "timed_out"
                  ? "text-amber-700 dark:text-amber-300"
                  : run.status === "cancelled"
                    ? "text-muted-foreground"
                    : "text-foreground/80";
            return (
              <Link
                key={run.id}
                to={`/agents/${group.agentId}/runs/${run.id}`}
                className="flex items-start gap-2.5 px-4 py-2.5 text-sm no-underline text-inherit transition-colors hover:bg-accent/50"
              >
                {statusIcon}
                <div className="min-w-0 flex-1">
                  {issue && (
                    <span className="mr-1.5 text-xs text-muted-foreground font-mono">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                  )}
                  <span className={cn("text-sm", textClass)}>
                    {run.summary}
                  </span>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-xs text-muted-foreground">{timeAgo(run.timestamp)}</div>
                  {(run.inputTokens + run.outputTokens) > 0 && (
                    <div className="text-[11px] text-muted-foreground/60">
                      {formatTokens(run.inputTokens + run.outputTokens)} tok
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */

export function AgentWorkToday() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Dashboard", href: "/dashboard" },
      { label: "Today's Agent Work" },
    ]);
  }, [setBreadcrumbs]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.heartbeats(selectedCompanyId!),
    queryFn: () => heartbeatsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const issueMap = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const i of issues ?? []) map.set(i.id, i);
    return map;
  }, [issues]);

  const groups = useMemo(
    () => groupRunsByAgent(runs ?? [], agentMap),
    [runs, agentMap],
  );

  const totalRuns = groups.reduce((sum, g) => sum + g.runs.length, 0);
  const totalTokens = groups.reduce((sum, g) => sum + g.totalTokens, 0);
  const totalCost = groups.reduce((sum, g) => sum + g.totalCostCents, 0);
  const totalSucceeded = groups.reduce((sum, g) => sum + g.succeeded, 0);
  const totalFailed = groups.reduce((sum, g) => sum + g.failed, 0);
  const totalActive = groups.reduce((sum, g) => sum + g.active, 0);

  if (isLoading) return <PageSkeleton variant="dashboard" />;

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        message="No agent work today yet. Runs will appear here as agents complete tasks."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="font-medium">{totalRuns} runs across {groups.length} agents</span>
        {totalActive > 0 && (
          <span className="inline-flex items-center gap-1 text-cyan-600 dark:text-cyan-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />{totalActive} active
          </span>
        )}
        {totalSucceeded > 0 && (
          <span className="text-emerald-600 dark:text-emerald-400">{totalSucceeded} succeeded</span>
        )}
        {totalFailed > 0 && (
          <span className="text-red-600 dark:text-red-400">{totalFailed} failed</span>
        )}
        {totalTokens > 0 && (
          <span className="text-muted-foreground">{formatTokens(totalTokens)} tokens</span>
        )}
        {totalCost > 0 && (
          <span className="text-muted-foreground">{formatCents(totalCost)}</span>
        )}
      </div>

      {/* Agent cards — no limit, runs expanded */}
      <div className="space-y-4">
        {groups.map((group) => (
          <FullAgentWorkCard key={group.agentId} group={group} issueMap={issueMap} />
        ))}
      </div>
    </div>
  );
}
