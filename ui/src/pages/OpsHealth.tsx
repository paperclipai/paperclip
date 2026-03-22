import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { dashboardApi } from "../api/dashboard";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ShieldCheck, CheckCircle2, Clock3, Siren, ActivitySquare } from "lucide-react";

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
    return { emoji: "🟠", label: "At risk", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" };
  }
  if (!agent.lastHeartbeatAt) {
    return { emoji: "🟠", label: "Waiting", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" };
  }
  return { emoji: "🟢", label: "Healthy", className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30" };
}

function laneEmoji(lane: RoutineJob["lane"]) {
  if (lane === "Marketing") return "📣";
  if (lane === "Trading") return "📈";
  if (lane === "Memory") return "🧠";
  return "⚙️";
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
      <section className="rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <ActivitySquare className="h-4 w-4 text-cyan-500" />
          <h2 className="text-sm font-semibold">📊 Control Tower Snapshot</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-5">
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">🧾 Open Tasks</p>
            <p className="text-xl font-semibold">{dashboard?.tasks.open ?? 0}</p>
          </div>
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">⛔ Blocked</p>
            <p className="text-xl font-semibold text-amber-600">{dashboard?.tasks.blocked ?? 0}</p>
          </div>
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">✅ Pending Approvals</p>
            <p className="text-xl font-semibold">{dashboard?.pendingApprovals ?? 0}</p>
          </div>
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">🧩 Routine Jobs</p>
            <p className="text-xl font-semibold">{routineJobs.length}</p>
          </div>
          <div className="rounded-lg border bg-background p-3">
            <p className="text-xs text-muted-foreground">🔥 High Critical</p>
            <p className="text-xl font-semibold text-rose-600">{highCriticalCount}</p>
          </div>
        </div>
      </section>

      <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        Includes all routine Felix/Katya/topic jobs. Live heartbeat + coverage registry in one view.
      </div>

      {companyAgents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No scheduler heartbeat agents found for this company." />
      ) : (
        <section className="rounded-lg border bg-card overflow-hidden">
          <div className="border-b px-3 py-2 text-sm font-semibold">🫀 Scheduler Heartbeat (Live)</div>
          <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b bg-muted/20">
            <div className="col-span-2">RAG</div>
            <div className="col-span-4">Agent</div>
            <div className="col-span-2">Adapter</div>
            <div className="col-span-4 text-right">Last Heartbeat</div>
          </div>
          <div className="divide-y">
            {companyAgents.map((agent) => {
              const rag = ragFromAgent(agent as any);
              return (
                <div key={agent.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-sm items-center">
                  <div className="col-span-2">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${rag.className}`}>
                      {rag.emoji} {rag.label}
                    </span>
                  </div>
                  <div className="col-span-4 font-medium">{agent.agentName}</div>
                  <div className="col-span-2 text-muted-foreground">{agent.adapterType}</div>
                  <div className="col-span-4 text-right text-xs text-muted-foreground">
                    {agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : "never"}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="rounded-lg border bg-card overflow-hidden">
        <div className="border-b px-3 py-2 text-sm font-semibold">🗂️ Routine Jobs Registry (Felix + Katya + Topics)</div>
        <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b bg-muted/20">
          <div className="col-span-4">Job</div>
          <div className="col-span-2">Owner</div>
          <div className="col-span-2">Lane</div>
          <div className="col-span-2">Topic</div>
          <div className="col-span-1">Cadence</div>
          <div className="col-span-1 text-right">Priority</div>
        </div>
        <div className="divide-y">
          {routineJobs.map((job) => (
            <div key={job.name} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center">
              <div className="col-span-4 font-medium truncate">{job.name}</div>
              <div className="col-span-2 text-muted-foreground">{job.owner}</div>
              <div className="col-span-2">
                <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                  <span>{laneEmoji(job.lane)}</span>
                  <span>{job.lane}</span>
                </span>
              </div>
              <div className="col-span-2 text-muted-foreground">{job.topic}</div>
              <div className="col-span-1 text-muted-foreground truncate" title={job.cadence}>{job.cadence}</div>
              <div className="col-span-1 text-right">
                {job.criticality === "high" ? (
                  <span className="inline-flex items-center gap-1 text-rose-600"><Siren className="h-3 w-3" />H</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-muted-foreground"><Clock3 className="h-3 w-3" />M</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
        <p className="font-semibold text-foreground mb-1">🎯 Quick Operator Focus</p>
        <ul className="list-disc ml-4 space-y-1">
          <li>📣 Marketing automation jobs tracked: {marketingCount}</li>
          <li>⚡ Review blocked tasks + pending approvals first for fastest unblocks</li>
          <li>🔥 If any high-criticality routine drifts, escalate immediately in handoff</li>
        </ul>
      </section>
    </div>
  );
}
