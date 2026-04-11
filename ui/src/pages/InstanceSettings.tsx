import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, ExternalLink, Settings } from "lucide-react";
import type { InstanceSchedulerHeartbeatAgent } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { routinesApi } from "../api/routines";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys } from "../lib/queryKeys";
import {
  buildActiveRoutineAssigneeIndex,
  buildHeartbeatAuditRows,
  type HeartbeatAuditRow,
  HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
} from "../lib/heartbeat-audit";
import { formatDateTime, relativeTime } from "../lib/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function buildAgentHref(agent: InstanceSchedulerHeartbeatAgent) {
  return `/${agent.companyIssuePrefix}/agents/${encodeURIComponent(agent.agentUrlKey)}`;
}

export function InstanceSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Heartbeats" },
    ]);
  }, [setBreadcrumbs]);

  const heartbeatsQuery = useQuery({
    queryKey: queryKeys.instance.schedulerHeartbeats,
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 15_000,
  });

  const agents = heartbeatsQuery.data ?? [];
  const companyIds = useMemo(
    () => [...new Set(agents.map((agent) => agent.companyId))],
    [agents],
  );

  const routineQueries = useQueries({
    queries: companyIds.map((companyId) => ({
      queryKey: queryKeys.routines.list(companyId),
      queryFn: () => routinesApi.list(companyId),
      enabled: companyIds.length > 0,
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });

  const routinesByCompanyId = useMemo(() => {
    const result: Record<string, Awaited<ReturnType<typeof routinesApi.list>>> = {};
    companyIds.forEach((companyId, index) => {
      result[companyId] = routineQueries[index]?.data ?? [];
    });
    return result;
  }, [companyIds, routineQueries]);

  const routinesLoading = routineQueries.some((query) => query.isLoading || query.isFetching);
  const routinesError = routineQueries.find((query) => query.error)?.error;
  const routineCoverageReady = !routinesLoading && !routinesError;

  const activeRoutineAssigneesByCompany = useMemo(
    () => buildActiveRoutineAssigneeIndex(routinesByCompanyId),
    [routinesByCompanyId],
  );

  const auditRows = useMemo(
    () => {
      const rows = buildHeartbeatAuditRows(agents, activeRoutineAssigneesByCompany);
      if (routineCoverageReady) return rows;
      // Avoid false positives while routine coverage is still loading or unavailable.
      return rows.map((row) => ({
        ...row,
        missingRoutineCoverage: false,
        flagged: row.shortInterval,
      }));
    },
    [agents, activeRoutineAssigneesByCompany, routineCoverageReady],
  );

  const flaggedRows = useMemo(
    () => auditRows.filter((row) => row.flagged),
    [auditRows],
  );

  const shortIntervalCount = useMemo(
    () => auditRows.filter((row) => row.shortInterval).length,
    [auditRows],
  );

  const missingRoutineCoverageCount = useMemo(
    () => auditRows.filter((row) => row.missingRoutineCoverage).length,
    [auditRows],
  );

  const toggleMutation = useMutation({
    mutationFn: async (agentRow: InstanceSchedulerHeartbeatAgent) => {
      const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
      const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
      const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};

      return agentsApi.update(
        agentRow.id,
        {
          runtimeConfig: {
            ...runtimeConfig,
            heartbeat: {
              ...heartbeat,
              enabled: !agentRow.heartbeatEnabled,
            },
          },
        },
        agentRow.companyId,
      );
    },
    onSuccess: async (_, agentRow) => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(agentRow.companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRow.id) }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update heartbeat.");
    },
  });

  async function disableTimerHeartbeats(agentRows: InstanceSchedulerHeartbeatAgent[]) {
    const enabled = agentRows.filter((a) => a.heartbeatEnabled);
    if (enabled.length === 0) return enabled;

    const results = await Promise.allSettled(
      enabled.map(async (agentRow) => {
        const agent = await agentsApi.get(agentRow.id, agentRow.companyId);
        const runtimeConfig = asRecord(agent.runtimeConfig) ?? {};
        const heartbeat = asRecord(runtimeConfig.heartbeat) ?? {};
        await agentsApi.update(
          agentRow.id,
          {
            runtimeConfig: {
              ...runtimeConfig,
              heartbeat: { ...heartbeat, enabled: false },
            },
          },
          agentRow.companyId,
        );
      }),
    );

    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      const firstError = failures[0]?.reason;
      const detail = firstError instanceof Error ? firstError.message : "Unknown error";
      throw new Error(
        failures.length === 1
          ? `Failed to disable 1 timer heartbeat: ${detail}`
          : `Failed to disable ${failures.length} of ${enabled.length} timer heartbeats. First error: ${detail}`,
      );
    }
    return enabled;
  }

  async function handleBulkDisableSuccess(updatedRows: InstanceSchedulerHeartbeatAgent[]) {
    setActionError(null);
    const companies = new Set(updatedRows.map((row) => row.companyId));
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.instance.schedulerHeartbeats }),
      ...Array.from(companies, (companyId) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
      ),
      ...Array.from(companies, (companyId) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(companyId) }),
      ),
      ...updatedRows.map((row) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(row.id) }),
      ),
    ]);
  }

  const disableAllMutation = useMutation({
    mutationFn: disableTimerHeartbeats,
    onSuccess: handleBulkDisableSuccess,
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disable all heartbeats.");
    },
  });

  const disableAuditedMutation = useMutation({
    mutationFn: (rows: HeartbeatAuditRow[]) => disableTimerHeartbeats(rows.filter((row) => row.flagged)),
    onSuccess: handleBulkDisableSuccess,
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to disable audited heartbeats.");
    },
  });

  const activeCount = agents.filter((agent) => agent.schedulerActive).length;
  const disabledCount = agents.length - activeCount;
  const enabledCount = agents.filter((agent) => agent.heartbeatEnabled).length;
  const anyEnabled = enabledCount > 0;
  const anyAudited = flaggedRows.length > 0;
  const flaggedRowsSorted = useMemo(
    () => flaggedRows.slice().sort((left, right) => left.intervalSec - right.intervalSec),
    [flaggedRows],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, { companyName: string; agents: HeartbeatAuditRow[] }>();
    for (const agent of auditRows) {
      let group = map.get(agent.companyId);
      if (!group) {
        group = { companyName: agent.companyName, agents: [] };
        map.set(agent.companyId, group);
      }
      group.agents.push(agent);
    }
    return [...map.values()];
  }, [auditRows]);

  if (heartbeatsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading scheduler heartbeats...</div>;
  }

  if (heartbeatsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {heartbeatsQuery.error instanceof Error
          ? heartbeatsQuery.error.message
          : "Failed to load scheduler heartbeats."}
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Scheduler Heartbeats</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Agents with a timer heartbeat enabled across all of your companies.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{activeCount}</span> active</span>
        <span><span className="font-semibold text-foreground">{disabledCount}</span> disabled</span>
        <span><span className="font-semibold text-foreground">{grouped.length}</span> {grouped.length === 1 ? "company" : "companies"}</span>
        <span><span className="font-semibold text-foreground">{shortIntervalCount}</span> under 15m</span>
        <span><span className="font-semibold text-foreground">{missingRoutineCoverageCount}</span> without active routine</span>
        <div className="ml-auto flex items-center gap-2">
          {anyAudited && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={
                disableAuditedMutation.isPending
                || disableAllMutation.isPending
                || !routineCoverageReady
              }
              onClick={() => {
                if (!window.confirm(`Disable timer heartbeats for ${flaggedRows.length} audited agent(s)?`)) {
                  return;
                }
                disableAuditedMutation.mutate(flaggedRows);
              }}
            >
              {disableAuditedMutation.isPending ? "Disabling..." : "Disable Audited"}
            </Button>
          )}
          {anyEnabled && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              disabled={disableAllMutation.isPending || disableAuditedMutation.isPending}
              onClick={() => {
                const noun = enabledCount === 1 ? "agent" : "agents";
                if (!window.confirm(`Disable timer heartbeats for all ${enabledCount} enabled ${noun}?`)) {
                  return;
                }
                disableAllMutation.mutate(agents);
              }}
            >
              {disableAllMutation.isPending ? "Disabling..." : "Disable All"}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Heartbeat audit</div>
            <p className="text-xs text-muted-foreground">
              Flags timer heartbeats under {HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC / 60} minutes and timer heartbeats without an active routine assignment.
              Monitoring pollers can be valid exceptions.
            </p>
            {routinesLoading && (
              <p className="text-xs text-muted-foreground">Checking routine coverage...</p>
            )}
            {routinesError && (
              <p className="text-xs text-destructive">
                Routine coverage check failed: {routinesError instanceof Error ? routinesError.message : "Unknown error"}
              </p>
            )}
            {!routineCoverageReady && (
              <p className="text-xs text-muted-foreground">
                Routine coverage flags are paused until coverage data is available.
              </p>
            )}
          </div>
          {flaggedRowsSorted.length === 0 ? (
            <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              No flagged timer heartbeats found.
            </div>
          ) : (
            <div className="space-y-2">
              {flaggedRowsSorted.map((agent) => {
                const saving = toggleMutation.isPending && toggleMutation.variables?.id === agent.id;
                return (
                  <div key={`audit-${agent.id}`} className="flex items-center gap-2 border border-border px-3 py-2 text-xs">
                    <Link to={buildAgentHref(agent)} className="min-w-0 truncate font-medium hover:underline">
                      {agent.agentName}
                    </Link>
                    <span className="text-muted-foreground tabular-nums">{agent.intervalSec}s</span>
                    {agent.shortInterval && <Badge variant="outline">Under 15m</Badge>}
                    {agent.missingRoutineCoverage && <Badge variant="outline">No active routine</Badge>}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-6 px-2 text-xs"
                      disabled={saving}
                      onClick={() => toggleMutation.mutate(agent)}
                    >
                      {saving ? "..." : "Disable timer"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon={Clock3}
          message="No scheduler heartbeats match the current criteria."
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <Card key={group.companyName}>
              <CardContent className="p-0">
                <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.companyName}
                </div>
                <div className="divide-y">
                  {group.agents.map((agent) => {
                    const saving = toggleMutation.isPending && toggleMutation.variables?.id === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 px-3 py-2 text-sm"
                      >
                        <Badge
                          variant={agent.schedulerActive ? "default" : "outline"}
                          className="shrink-0 text-[10px] px-1.5 py-0"
                        >
                          {agent.schedulerActive ? "On" : "Off"}
                        </Badge>
                        <Link
                          to={buildAgentHref(agent)}
                          className="font-medium truncate hover:underline"
                        >
                          {agent.agentName}
                        </Link>
                        <span className="hidden sm:inline text-muted-foreground truncate">
                          {humanize(agent.title ?? agent.role)}
                        </span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {agent.intervalSec}s
                        </span>
                        <span
                          className="hidden md:inline text-muted-foreground truncate"
                          title={agent.lastHeartbeatAt ? formatDateTime(agent.lastHeartbeatAt) : undefined}
                        >
                          {agent.lastHeartbeatAt
                            ? relativeTime(agent.lastHeartbeatAt)
                            : "never"}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5 shrink-0">
                          <Link
                            to={buildAgentHref(agent)}
                            className="text-muted-foreground hover:text-foreground"
                            title="Full agent config"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            disabled={saving}
                            onClick={() => toggleMutation.mutate(agent)}
                          >
                            {saving ? "..." : agent.heartbeatEnabled ? "Disable Timer Heartbeat" : "Enable Timer Heartbeat"}
                          </Button>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
