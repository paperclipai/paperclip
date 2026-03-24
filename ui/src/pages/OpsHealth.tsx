import { useEffect, useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { pluginsApi } from "../api/plugins";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ShieldCheck } from "lucide-react";

function ragForJob(status: string, nextRunAt: Date | null, lastRunAt: Date | null) {
  if (status === "failed") return { label: "Red", className: "text-rose-600" };
  if (!nextRunAt && !lastRunAt) return { label: "Amber", className: "text-amber-600" };
  if (nextRunAt && nextRunAt.getTime() < Date.now() - 5 * 60_000) return { label: "Amber", className: "text-amber-600" };
  return { label: "Green", className: "text-emerald-600" };
}

export function OpsHealth() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Ops Health" }]);
  }, [setBreadcrumbs]);

  const { data: schedulerAgents, isLoading, error } = useQuery({
    queryKey: ["ops-health", "scheduler-agents"],
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 30_000,
  });

  const { data: plugins } = useQuery({
    queryKey: ["ops-health", "plugins"],
    queryFn: () => pluginsApi.list(),
    refetchInterval: 30_000,
  });

  const readyPlugins = useMemo(() => (plugins ?? []).filter((plugin) => plugin.status === "ready"), [plugins]);

  const pluginJobsQueries = useQueries({
    queries: readyPlugins.map((plugin) => ({
      queryKey: ["ops-health", "plugin-jobs", plugin.id],
      queryFn: () => pluginsApi.listJobs(plugin.id),
      refetchInterval: 30_000,
    })),
  });

  const dashboardQueries = useQueries({
    queries: readyPlugins.map((plugin) => ({
      queryKey: ["ops-health", "plugin-dashboard", plugin.id],
      queryFn: () => pluginsApi.dashboard(plugin.id),
      refetchInterval: 30_000,
    })),
  });

  const runNow = useMutation({
    mutationFn: ({ pluginId, jobId }: { pluginId: string; jobId: string }) => pluginsApi.triggerJob(pluginId, jobId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["ops-health", "plugin-jobs", vars.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["ops-health", "plugin-dashboard", vars.pluginId] });
    },
  });

  const companyAgents = useMemo(() => {
    if (!selectedCompanyId) return [];
    return (schedulerAgents ?? []).filter((agent) => agent.companyId === selectedCompanyId);
  }, [schedulerAgents, selectedCompanyId]);

  const ragRows = useMemo(() => {
    return readyPlugins.flatMap((plugin, idx) => {
      const jobs = pluginJobsQueries[idx]?.data ?? [];
      const dashboard = dashboardQueries[idx]?.data;
      return jobs.map((job) => {
        const lastRunAt = job.lastRunAt ? new Date(job.lastRunAt) : null;
        const nextRunAt = job.nextRunAt ? new Date(job.nextRunAt) : null;
        const latestFailure = dashboard?.recentJobRuns?.find((run) => run.jobId === job.id && run.status === "failed");
        const rag = ragForJob(job.status, nextRunAt, lastRunAt);
        const blocker = latestFailure?.error ?? (job.status === "failed" ? "Job flagged failed" : null);
        const nextAction = blocker ? "Run now + inspect plugin logs" : "No action";
        return { plugin, job, rag, blocker, nextAction, lastRunAt, nextRunAt };
      });
    });
  }, [dashboardQueries, pluginJobsQueries, readyPlugins]);

  if (isLoading) return <PageSkeleton variant="dashboard" />;
  if (error) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load ops health"}</p>;

  return (
    <div className="space-y-4">
      {companyAgents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No scheduler heartbeat agents found for this company." />
      ) : (
        <section className="rounded-lg border bg-card overflow-hidden">
          <div className="border-b px-3 py-2 text-sm font-semibold">Scheduler Heartbeats</div>
          <div className="divide-y">
            {companyAgents.map((agent) => (
              <div key={agent.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-sm items-center">
                <div className="col-span-4 font-medium">{agent.agentName}</div>
                <div className="col-span-3 text-muted-foreground">{agent.adapterType}</div>
                <div className="col-span-2">{agent.schedulerActive ? "On" : "Off"}</div>
                <div className="col-span-3 text-right text-xs text-muted-foreground">{agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : "never"}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border bg-card overflow-hidden">
        <div className="border-b px-3 py-2 text-sm font-semibold">RAG Ops control panel</div>
        <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b bg-muted/20">
          <div className="col-span-2">RAG</div><div className="col-span-2">Plugin</div><div className="col-span-2">Job</div><div className="col-span-2">Last run</div><div className="col-span-2">Next run</div><div className="col-span-1">Blocker</div><div className="col-span-1">Action</div>
        </div>
        <div className="divide-y">
          {ragRows.length === 0 ? <div className="px-3 py-3 text-sm text-muted-foreground">No scheduled plugin jobs found.</div> : ragRows.map((row) => (
            <div key={row.job.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center">
              <div className={`col-span-2 font-semibold ${row.rag.className}`}>{row.rag.label}</div>
              <div className="col-span-2 truncate" title={row.plugin.pluginKey}>{row.plugin.pluginKey}</div>
              <div className="col-span-2 font-mono truncate" title={row.job.jobKey}>{row.job.jobKey}</div>
              <div className="col-span-2 text-muted-foreground">{row.lastRunAt ? row.lastRunAt.toLocaleString() : "never"}</div>
              <div className="col-span-2 text-muted-foreground">{row.nextRunAt ? row.nextRunAt.toLocaleString() : "n/a"}</div>
              <div className="col-span-1 truncate" title={row.blocker ?? ""}>{row.blocker ?? "—"}</div>
              <div className="col-span-1 text-right">
                <button className="text-[11px] underline disabled:no-underline disabled:text-muted-foreground" onClick={() => runNow.mutate({ pluginId: row.plugin.id, jobId: row.job.id })} disabled={runNow.isPending}>Run now</button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">If run-now is not permitted for a specific job, wire endpoint: POST /api/plugins/:pluginId/jobs/:jobId/trigger.</div>
      </section>
    </div>
  );
}
