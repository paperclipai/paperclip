import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Activity, Clock3, HeartPulse } from "lucide-react";
import type { Agent, HeartbeatRun } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl, formatDateTime, relativeTime } from "../lib/utils";
import { heartbeatTasksPage, nav } from "../lib/i18n";

interface HeartbeatConfigSummary {
  configured: boolean;
  enabled: boolean;
  intervalSec: number | null;
  cooldownSec: number | null;
  maxConcurrentRuns: number | null;
  continuationDelayMs: number | null;
  continuationMaxAttempts: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readHeartbeatConfig(agent: Agent): HeartbeatConfigSummary {
  const heartbeat = asRecord(agent.runtimeConfig?.heartbeat);
  const continuation = asRecord(heartbeat?.maxTurnContinuation);
  return {
    configured: Boolean(heartbeat),
    enabled: heartbeat?.enabled === true,
    intervalSec: asNumber(heartbeat?.intervalSec),
    cooldownSec: asNumber(heartbeat?.cooldownSec),
    maxConcurrentRuns: asNumber(heartbeat?.maxConcurrentRuns),
    continuationDelayMs: asNumber(continuation?.delayMs),
    continuationMaxAttempts: asNumber(continuation?.maxAttempts),
  };
}

function seconds(value: number | null): string {
  return value === null ? "—" : `${value}s`;
}

function durationMs(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 1000)}s`;
}

function formatRunReason(run: HeartbeatRun | undefined): string {
  if (!run) return "—";
  return run.contextSnapshot && typeof run.contextSnapshot.wakeReason === "string"
    ? run.contextSnapshot.wakeReason
    : run.invocationSource;
}

function latestRunByAgent(runs: HeartbeatRun[] | undefined) {
  const map = new Map<string, HeartbeatRun>();
  for (const run of runs ?? []) {
    const existing = map.get(run.agentId);
    const existingTime = existing?.createdAt ? new Date(existing.createdAt).getTime() : 0;
    const runTime = run.createdAt ? new Date(run.createdAt).getTime() : 0;
    if (!existing || runTime > existingTime) map.set(run.agentId, run);
  }
  return map;
}

export function HeartbeatTasks() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: nav.work }, { label: nav.heartbeatTasks }]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const liveRunsQuery = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.liveRuns(selectedCompanyId), "heartbeat-tasks"] : ["live-runs", "none", "heartbeat-tasks"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10_000,
  });

  const runsQuery = useQuery({
    queryKey: selectedCompanyId ? [...queryKeys.heartbeats(selectedCompanyId), "heartbeat-tasks"] : ["heartbeats", "none", "heartbeat-tasks"],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 80),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => {
    const latest = latestRunByAgent(runsQuery.data);
    const liveCountByAgent = new Map<string, number>();
    for (const run of liveRunsQuery.data ?? []) {
      liveCountByAgent.set(run.agentId, (liveCountByAgent.get(run.agentId) ?? 0) + 1);
    }

    return (agentsQuery.data ?? [])
      .map((agent) => ({
        agent,
        heartbeat: readHeartbeatConfig(agent),
        latestRun: latest.get(agent.id),
        liveCount: liveCountByAgent.get(agent.id) ?? 0,
      }))
      .filter((row) => row.heartbeat.configured || row.heartbeat.enabled || row.liveCount > 0)
      .sort((a, b) => {
        if (a.heartbeat.enabled !== b.heartbeat.enabled) return a.heartbeat.enabled ? -1 : 1;
        if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
        return a.agent.name.localeCompare(b.agent.name);
      });
  }, [agentsQuery.data, liveRunsQuery.data, runsQuery.data]);

  const enabledCount = rows.filter((row) => row.heartbeat.enabled).length;
  const configuredCount = rows.filter((row) => row.heartbeat.configured).length;
  const liveCount = rows.reduce((sum, row) => sum + row.liveCount, 0);

  if (!selectedCompanyId) {
    return <EmptyState icon={HeartPulse} message={heartbeatTasksPage.selectCompany} />;
  }

  if (agentsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (agentsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {agentsQuery.error instanceof Error ? agentsQuery.error.message : heartbeatTasksPage.failedToLoad}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{heartbeatTasksPage.title}</h1>
          </div>
          <p className="text-sm text-muted-foreground">{heartbeatTasksPage.subtitle}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{heartbeatTasksPage.enabledAgents}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{enabledCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{heartbeatTasksPage.configuredAgents}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{configuredCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{heartbeatTasksPage.liveRuns}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{liveCount}</div>
          </CardContent>
        </Card>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Clock3} message={heartbeatTasksPage.empty} />
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">{heartbeatTasksPage.agent}</th>
                <th className="px-3 py-2 text-left font-medium">{heartbeatTasksPage.state}</th>
                <th className="px-3 py-2 text-right font-medium">{heartbeatTasksPage.interval}</th>
                <th className="px-3 py-2 text-right font-medium">{heartbeatTasksPage.cooldown}</th>
                <th className="px-3 py-2 text-right font-medium">{heartbeatTasksPage.concurrent}</th>
                <th className="px-3 py-2 text-right font-medium">{heartbeatTasksPage.continuation}</th>
                <th className="px-3 py-2 text-left font-medium">{heartbeatTasksPage.lastHeartbeat}</th>
                <th className="px-3 py-2 text-left font-medium">{heartbeatTasksPage.lastRun}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(({ agent, heartbeat, latestRun, liveCount }) => (
                <tr key={agent.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link to={agentUrl(agent)} className="font-medium hover:underline">
                      {agent.name}
                    </Link>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {agent.adapterType}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={heartbeat.enabled ? "default" : "outline"} className="text-[10px]">
                        {heartbeat.enabled ? heartbeatTasksPage.on : heartbeatTasksPage.off}
                      </Badge>
                      {liveCount > 0 ? (
                        <Badge variant="secondary" className="text-[10px]">
                          {heartbeatTasksPage.running(liveCount)}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{seconds(heartbeat.intervalSec)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{seconds(heartbeat.cooldownSec)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {heartbeat.maxConcurrentRuns ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {durationMs(heartbeat.continuationDelayMs)} / {heartbeat.continuationMaxAttempts ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {agent.lastHeartbeatAt ? (
                      <span title={formatDateTime(agent.lastHeartbeatAt)}>{relativeTime(agent.lastHeartbeatAt)}</span>
                    ) : (
                      heartbeatTasksPage.never
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {latestRun ? (
                      <Link
                        to={`${agentUrl(agent)}/runs/${latestRun.id}`}
                        className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline"
                        title={latestRun.startedAt ? formatDateTime(latestRun.startedAt) : undefined}
                      >
                        <Activity className="h-3.5 w-3.5" />
                        <span>{latestRun.status}</span>
                        <span className="text-xs">· {formatRunReason(latestRun)}</span>
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
