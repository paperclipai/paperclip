import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";

type RoutineJob = {
  name: string;
  owner: "Felix" | "Katya";
  lane: "Ops" | "Marketing" | "Trading" | "Memory";
  topic: string;
  cadence: string;
  criticality: "high" | "medium";
};

const routineJobs: RoutineJob[] = [
  { name: "felix-sprint-checkin-twice-daily", owner: "Felix", lane: "Ops", topic: "topic 1", cadence: "09:00 + 17:00", criticality: "medium" },
  { name: "felix-memory-integrity-2x-daily", owner: "Felix", lane: "Memory", topic: "topic 1", cadence: "10:00 + 15:00", criticality: "high" },
  { name: "nightly-memory-dive", owner: "Felix", lane: "Memory", topic: "topic 1", cadence: "21:00", criticality: "high" },
  { name: "felix-nightly-improvement", owner: "Felix", lane: "Ops", topic: "topic 1", cadence: "22:30", criticality: "medium" },
  { name: "katya-memory-integrity-2x-daily", owner: "Katya", lane: "Memory", topic: "topic 104", cadence: "10:00 + 15:00", criticality: "high" },
  { name: "katya-memory-file-guardrail", owner: "Katya", lane: "Memory", topic: "topic 104", cadence: "hourly :12", criticality: "high" },
  { name: "katya-nightly-memory-dive", owner: "Katya", lane: "Memory", topic: "topic 104", cadence: "21:30", criticality: "high" },
  { name: "katya-nightly-improvement", owner: "Katya", lane: "Ops", topic: "topic 104", cadence: "23:05", criticality: "medium" },
  { name: "katya-daily-notes", owner: "Katya", lane: "Memory", topic: "topic 104", cadence: "23:10", criticality: "high" },
  { name: "katya-full-content-calendar-autonomy", owner: "Katya", lane: "Marketing", topic: "topic 104", cadence: "07:00", criticality: "high" },
  { name: "katya-cron-watchdog", owner: "Katya", lane: "Ops", topic: "topic 104", cadence: "08:07", criticality: "high" },
  { name: "katya-linkedin-preflight-before-9am-uk-post", owner: "Katya", lane: "Marketing", topic: "topic 104", cadence: "one-shot", criticality: "high" },
  { name: "katya-0900-uk-publish-objective-locked", owner: "Katya", lane: "Marketing", topic: "topic 104", cadence: "one-shot", criticality: "high" },
  { name: "polymarket-papertrade-watchdog-topic1048", owner: "Felix", lane: "Trading", topic: "topic 1048", cadence: "every 15m", criticality: "high" },
];

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

  const highCriticalCount = routineJobs.filter((j) => j.criticality === "high").length;
  const marketingCount = routineJobs.filter((j) => j.lane === "Marketing").length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-5">
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
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">Routine jobs tracked</p>
          <p className="text-xl font-semibold">{routineJobs.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <p className="text-xs text-muted-foreground">High criticality jobs</p>
          <p className="text-xl font-semibold">{highCriticalCount}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        This page now tracks all routine Felix/Katya/topic jobs used to run operations. Scheduler heartbeat data is live; routine-job registry is policy-backed coverage.
      </div>

      {companyAgents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No scheduler heartbeat agents found for this company." />
      ) : (
        <div className="rounded-lg border bg-card">
          <div className="border-b px-3 py-2 text-sm font-medium">Scheduler heartbeat (live)</div>
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

      <div className="rounded-lg border bg-card">
        <div className="border-b px-3 py-2 text-sm font-medium">Routine jobs registry (Felix + Katya + Topics)</div>
        <div className="divide-y">
          {routineJobs.map((job) => (
            <div key={job.name} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center">
              <div className="col-span-5 font-medium truncate">{job.name}</div>
              <div className="col-span-2 text-muted-foreground">{job.owner}</div>
              <div className="col-span-2 text-muted-foreground">{job.topic}</div>
              <div className="col-span-2 text-muted-foreground">{job.cadence}</div>
              <div className="col-span-1 text-right">
                {job.criticality === "high" ? (
                  <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" />H</span>
                ) : (
                  <span className="text-muted-foreground">M</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground mb-1">Quick operator focus</p>
        <ul className="list-disc ml-4 space-y-1">
          <li>Marketing automation jobs tracked: {marketingCount}</li>
          <li>Review blocked tasks + pending approvals first for fastest unblocks</li>
          <li>If any high-criticality routine drifts, escalate immediately in handoff</li>
        </ul>
      </div>
    </div>
  );
}
