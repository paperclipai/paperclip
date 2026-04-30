import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Clock, OctagonX, Play, Puzzle } from "lucide-react";
import { Link } from "@/lib/router";
import { instanceSettingsApi } from "../api/instanceSettings";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { pluginsApi } from "../api/plugins";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime, formatDateTime, cn } from "../lib/utils";

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export function SystemHealth() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "System Health" },
    ]);
  }, [setBreadcrumbs]);

  const statusQuery = useQuery({
    queryKey: queryKeys.instance.adminStatus,
    queryFn: () => instanceSettingsApi.getAdminStatus(),
    refetchInterval: 15_000,
    retry: false,
  });

  const allAgentsQuery = useQuery({
    queryKey: queryKeys.instance.allAgents,
    queryFn: async () => {
      const companies = await companiesApi.list();
      const perCompany = await Promise.all(companies.map((c) => agentsApi.list(c.id)));
      return perCompany.flat();
    },
    refetchInterval: 30_000,
  });

  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const unpause = useMutation({
    mutationFn: () => instanceSettingsApi.adminUnpause(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.adminStatus });
    },
  });

  const clearAutoPause = useMutation({
    mutationFn: (agentId: string) => agentsApi.unpauseAuto(agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.allAgents });
    },
  });

  const status = statusQuery.data;
  const autoPausedAgents = (allAgentsQuery.data ?? []).filter((agent) => {
    const rc = asRecord(agent.runtimeConfig);
    return (rc?.autoPause as { paused?: boolean } | undefined)?.paused === true;
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">System Health</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          System pause state, auto-paused agents, and plugin status.
        </p>
      </div>

      {/* System pause */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          System Pause
        </h2>
        <Card>
          <CardContent className="p-4">
            {statusQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : statusQuery.error ? (
              <p className="text-sm text-destructive">
                Could not load system status.{" "}
                {statusQuery.error instanceof Error ? statusQuery.error.message : ""}
              </p>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={status?.paused ? "destructive" : "outline"}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {status?.paused ? "Paused" : "Running"}
                    </Badge>
                    <span className="text-sm font-medium">
                      Agent run enqueuing is {status?.paused ? "blocked" : "active"}
                    </span>
                  </div>
                  {status?.paused && status.pauseReason && (
                    <p className="text-xs text-muted-foreground">Reason: {status.pauseReason}</p>
                  )}
                  {status?.paused && status.pausedAt && (
                    <p className="text-xs text-muted-foreground">
                      Since {formatDateTime(status.pausedAt)} ({relativeTime(status.pausedAt)})
                    </p>
                  )}
                  {(status?.queuedRunCount ?? 0) > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">
                        {status!.queuedRunCount} queued run{status!.queuedRunCount !== 1 ? "s" : ""} pending
                      </span>
                    </div>
                  )}
                </div>
                {status?.paused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={unpause.isPending}
                    onClick={() => unpause.mutate()}
                    className="shrink-0 flex items-center gap-1.5"
                  >
                    <Play className="h-3.5 w-3.5" />
                    {unpause.isPending ? "Resuming…" : "Resume System"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground italic">
                    No manual action needed
                  </span>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Auto-paused agents */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Auto-Paused Agents
          </h2>
          {autoPausedAgents.length > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
              {autoPausedAgents.length}
            </Badge>
          )}
        </div>
        {allAgentsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading agents…</p>
        ) : autoPausedAgents.length === 0 ? (
          <Card>
            <CardContent className="px-4 py-3">
              <p className="text-sm text-muted-foreground">No agents are currently auto-paused.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {autoPausedAgents.map((agent) => {
                  const rc = asRecord(agent.runtimeConfig);
                  const autoPause = rc?.autoPause as
                    | { paused?: boolean; reason?: string; triggeredAt?: string }
                    | undefined;
                  const clearing = clearAutoPause.isPending && clearAutoPause.variables === agent.id;
                  return (
                    <div key={agent.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                      <OctagonX className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/agents/${encodeURIComponent(agent.urlKey ?? agent.id)}`}
                          className="font-medium hover:underline"
                        >
                          {agent.name}
                        </Link>
                        {autoPause?.reason && (
                          <p className="text-xs text-muted-foreground">{autoPause.reason}</p>
                        )}
                        {autoPause?.triggeredAt && (
                          <p className="text-xs text-muted-foreground">
                            {relativeTime(autoPause.triggeredAt)}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs shrink-0"
                        disabled={clearing}
                        onClick={() => clearAutoPause.mutate(agent.id)}
                      >
                        {clearing ? "Clearing…" : "Clear"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {/* Plugin status */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Plugins
        </h2>
        <Card>
          <CardContent className="p-0">
            {pluginsQuery.isLoading ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
            ) : (pluginsQuery.data ?? []).length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                <Puzzle className="h-4 w-4 shrink-0" />
                No plugins installed.
              </div>
            ) : (
              <div className="divide-y">
                {(pluginsQuery.data ?? []).map((plugin) => (
                  <div key={plugin.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                    <Puzzle className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 font-medium truncate">
                      {plugin.manifestJson.displayName ?? plugin.packageName}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] px-1.5 py-0 shrink-0",
                        plugin.status === "ready"
                          ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
                          : "border-muted text-muted-foreground",
                      )}
                    >
                      {plugin.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
