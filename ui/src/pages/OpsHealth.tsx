import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ShieldCheck } from "lucide-react";

function ragFromAgent(agent: { schedulerActive: boolean; heartbeatEnabled: boolean; lastHeartbeatAt: string | null }) {
  if (!agent.heartbeatEnabled || !agent.schedulerActive) {
    return { emoji: "🟠", label: "At risk" };
  }
  if (!agent.lastHeartbeatAt) {
    return { emoji: "🟠", label: "Waiting" };
  }
  return { emoji: "🟢", label: "Healthy" };
}

export function OpsHealth() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Ops Health" }]);
  }, [setBreadcrumbs]);

  const { data: schedulerAgents, isLoading, error } = useQuery({
    queryKey: ["ops-health", "scheduler-agents"],
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 30_000,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const companyAgents = useMemo(() => {
    if (!selectedCompanyId) return [];
    return (schedulerAgents ?? []).filter((agent) => agent.companyId === selectedCompanyId);
  }, [schedulerAgents, selectedCompanyId]);

  if (isLoading) return <PageSkeleton variant="dashboard" />;
  if (error) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load ops health"}</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">Open tasks</p>
          <p className="text-xl font-semibold">{dashboard?.tasks.open ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">Blocked tasks</p>
          <p className="text-xl font-semibold">{dashboard?.tasks.blocked ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">Pending approvals</p>
          <p className="text-xl font-semibold">{dashboard?.pendingApprovals ?? 0}</p>
        </div>
      </div>

      {companyAgents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No scheduler heartbeat agents found for this company." />
      ) : (
        <div className="rounded-lg border bg-card">
          <div className="border-b px-3 py-2 text-sm font-medium">Recurring operations health</div>
          <div className="divide-y">
            {companyAgents.map((agent) => {
              const rag = ragFromAgent(agent as any);
              return (
                <div key={agent.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-16 text-xs">{rag.emoji} {rag.label}</span>
                  <span className="min-w-[180px] font-medium">{agent.agentName}</span>
                  <span className="text-muted-foreground">{agent.adapterType}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    last heartbeat: {agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : "never"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
