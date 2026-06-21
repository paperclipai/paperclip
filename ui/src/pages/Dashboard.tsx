import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import { Bot, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle, Siren, FlaskConical, FileText, LockKeyhole, ClipboardCheck, ShieldAlert, Wrench } from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type { Agent, Issue } from "@paperclipai/shared";
import { formatExperimentWindow, summarizeMicroRegistry } from "../lib/micro-registry";
import { PluginSlotOutlet } from "@/plugins/slots";

const DASHBOARD_ACTIVITY_LIMIT = 10;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

type OperationalLoopMetadata = {
  title?: string;
  routine?: { id?: string | null; title?: string | null; status?: string | null; triggerEnabled?: boolean | null } | null;
  id?: string | null;
};

function readOperationalLoopMetadata(value: unknown): OperationalLoopMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const routine = record.routine && typeof record.routine === "object" && !Array.isArray(record.routine)
    ? record.routine as Record<string, unknown>
    : null;
  return {
    title: typeof record.title === "string" ? record.title : undefined,
    id: typeof record.id === "string" ? record.id : undefined,
    routine: routine ? {
      id: typeof routine.id === "string" ? routine.id : null,
      title: typeof routine.title === "string" ? routine.title : null,
      status: typeof routine.status === "string" ? routine.status : null,
      triggerEnabled: typeof routine.triggerEnabled === "boolean" ? routine.triggerEnabled : null,
    } : null,
  };
}

function routineTitleFromLoopSummary(summary: string) {
  return summary.split(" created ")[0]?.trim() || summary;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { openOnboarding } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [animatedActivityIds, setAnimatedActivityIds] = useState<Set<string>>(new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  const hydratedActivityRef = useRef(false);
  const activityAnimationTimersRef = useRef<number[]>([]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId!),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: controlRoom } = useQuery({
    queryKey: [...queryKeys.dashboard(selectedCompanyId!), "ceo-control-room"],
    queryFn: () => dashboardApi.ceoControlRoom(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const { data: microRegistry } = useQuery({
    queryKey: [...queryKeys.dashboard(selectedCompanyId!), "micro-registry"],
    queryFn: () => dashboardApi.microRegistry(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
  });

  const refreshControlRoom = () => {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    void queryClient.invalidateQueries({ queryKey: [...queryKeys.dashboard(selectedCompanyId), "ceo-control-room"] });
  };

  const incidentMutation = useMutation({
    mutationFn: (input: { routineTitle: string; routineId?: string | null }) => dashboardApi.openOperationalIncident(selectedCompanyId!, {
      ...input,
      note: "Created from CEO Operations panel to coalesce repeated watchdog reports.",
    }),
    onSuccess: () => {
      pushToast({ title: "Durable incident opened", body: "Watchdog output will be routed to one owner instead of a fresh inbox issue.", tone: "success" });
      refreshControlRoom();
    },
    onError: (err) => pushToast({ title: "Could not open incident", body: err instanceof Error ? err.message : String(err), tone: "error" }),
  });

  const pauseRoutineMutation = useMutation({
    mutationFn: (routineId: string) => dashboardApi.pauseOperationalRoutine(selectedCompanyId!, routineId, {
      note: "Paused from CEO Operations panel while durable incident owns this watchdog loop.",
    }),
    onSuccess: () => {
      pushToast({ title: "Routine paused", body: "The noisy watchdog trigger is disabled.", tone: "success" });
      refreshControlRoom();
    },
    onError: (err) => pushToast({ title: "Could not pause routine", body: err instanceof Error ? err.message : String(err), tone: "error" }),
  });

  const { data: activity } = useQuery({
    queryKey: [...queryKeys.activity(selectedCompanyId!), { limit: DASHBOARD_ACTIVITY_LIMIT }],
    queryFn: () => activityApi.list(selectedCompanyId!, { limit: DASHBOARD_ACTIVITY_LIMIT }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const recentIssues = issues ? getRecentIssues(issues) : [];
  const recentActivity = useMemo(() => (activity ?? []).slice(0, 10), [activity]);
  const microSummary = useMemo(
    () => microRegistry ? summarizeMicroRegistry(microRegistry) : null,
    [microRegistry],
  );
  const visibleMicroExperiments = useMemo(
    () => (microRegistry?.experiments ?? []).slice(0, 4),
    [microRegistry?.experiments],
  );
  const openMicroDependencies = useMemo(
    () => (microRegistry?.dependencyRequests ?? []).filter((request) => !["resolved", "cancelled", "closed"].includes(request.status)).slice(0, 3),
    [microRegistry?.dependencyRequests],
  );
  const operationalLoopCategory = controlRoom?.categories.find((entry) => entry.key === "operational_loop");
  const operationalLoopItems = operationalLoopCategory?.items ?? [];

  useEffect(() => {
    for (const timer of activityAnimationTimersRef.current) {
      window.clearTimeout(timer);
    }
    activityAnimationTimersRef.current = [];
    seenActivityIdsRef.current = new Set();
    hydratedActivityRef.current = false;
    setAnimatedActivityIds(new Set());
  }, [selectedCompanyId]);

  useEffect(() => {
    if (recentActivity.length === 0) return;

    const seen = seenActivityIdsRef.current;
    const currentIds = recentActivity.map((event) => event.id);

    if (!hydratedActivityRef.current) {
      for (const id of currentIds) seen.add(id);
      hydratedActivityRef.current = true;
      return;
    }

    const newIds = currentIds.filter((id) => !seen.has(id));
    if (newIds.length === 0) {
      for (const id of currentIds) seen.add(id);
      return;
    }

    setAnimatedActivityIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    for (const id of newIds) seen.add(id);

    const timer = window.setTimeout(() => {
      setAnimatedActivityIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
      activityAnimationTimersRef.current = activityAnimationTimersRef.current.filter((t) => t !== timer);
    }, 980);
    activityAnimationTimersRef.current.push(timer);
  }, [recentActivity]);

  useEffect(() => {
    return () => {
      for (const timer of activityAnimationTimersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id.slice(0, 8));
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const p of projects ?? []) map.set(`project:${p.id}`, p.name);
    return map;
  }, [issues, agents, projects]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={LayoutDashboard}
          message="Welcome to Paperclip. Set up your first company and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select a company to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const hasNoAgents = agents !== undefined && agents.length === 0;

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 2, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      <ActiveAgentsPanel companyId={selectedCompanyId!} />

      {data && (
        <>
          {data.budgets.activeIncidents > 0 ? (
            <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-[linear-gradient(180deg,rgba(255,80,80,0.12),rgba(255,255,255,0.02))] px-4 py-3">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                <div>
                  <p className="text-sm font-medium text-red-50">
                    {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-red-100/70">
                    {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
                  </p>
                </div>
              </div>
              <Link to="/costs" className="text-sm underline underline-offset-2 text-red-100">
                Open budgets
              </Link>
            </div>
          ) : null}

          {controlRoom && controlRoom.categories.some((entry) => entry.count > 0) ? (
            <div className="rounded-xl border border-amber-500/25 bg-[linear-gradient(180deg,rgba(255,184,77,0.12),rgba(255,255,255,0.02))] p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <Siren className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="text-sm font-medium text-amber-50">CEO Control Room</p>
                    <p className="text-xs text-amber-100/70">
                      Read-only escalation scan · {controlRoom.summary.unavailableSources} unavailable source{controlRoom.summary.unavailableSources === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-amber-100/60">
                  {new Date(controlRoom.generatedAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {controlRoom.categories.map((entry) => (
                  <div key={entry.key} className="rounded-lg border border-white/10 bg-black/10 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground">{entry.label}</span>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          entry.severity === "critical"
                            ? "bg-red-500/20 text-red-100"
                            : entry.severity === "warning"
                              ? "bg-amber-500/20 text-amber-100"
                              : entry.severity === "info"
                                ? "bg-blue-500/20 text-blue-100"
                                : "bg-emerald-500/20 text-emerald-100",
                        )}
                      >
                        {entry.count}
                      </span>
                    </div>
                    {entry.items[0] ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.items[0].summary}</p>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">Clear</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {operationalLoopItems.length > 0 ? (
            <div className="overflow-hidden rounded-2xl border border-red-400/25 bg-[radial-gradient(circle_at_8%_0%,rgba(248,113,113,0.22),transparent_32%),linear-gradient(135deg,rgba(26,8,8,0.96),rgba(10,10,18,0.92))] shadow-[0_24px_80px_rgba(127,29,29,0.18)]">
              <div className="flex flex-col gap-3 border-b border-red-200/10 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl border border-red-200/20 bg-red-300/10 p-2">
                    <ShieldAlert className="h-5 w-5 text-red-100" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-red-100/70">CEO Operations</p>
                    <h2 className="mt-1 text-xl font-semibold text-white">Watchdog loops need durable owners</h2>
                    <p className="mt-1 max-w-3xl text-sm text-red-100/70">
                      Repeated liveness checks should become one open incident, not a treadmill of done reports. Actions here only create/append Paperclip incidents and pause routines; they do not launch compute or touch brokers.
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-red-200/10 bg-black/20 px-4 py-3 text-center">
                  <div className="text-2xl font-semibold text-white">{operationalLoopCategory?.count ?? operationalLoopItems.length}</div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-red-100/60">loop signals</div>
                </div>
              </div>
              <div className="grid gap-3 p-4 lg:grid-cols-3">
                {operationalLoopItems.slice(0, 6).map((item) => {
                  const metadata = readOperationalLoopMetadata(item.metadata);
                  const routine = metadata.routine;
                  const routineId = routine?.id ?? metadata.id ?? null;
                  const routineTitle = routine?.title ?? metadata.title ?? routineTitleFromLoopSummary(item.summary);
                  const isPaused = routine?.status === "paused" || routine?.triggerEnabled === false;
                  return (
                    <div key={`${item.type}:${item.summary}`} className="rounded-xl border border-red-100/10 bg-black/25 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Wrench className="h-3.5 w-3.5 text-red-100/70" />
                            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-red-100/60">{item.type.replace(/_/g, " ")}</span>
                          </div>
                          <p className="mt-2 line-clamp-3 text-sm font-medium text-red-50">{item.summary}</p>
                          <p className="mt-2 text-xs text-red-100/55">
                            Routine: {routineTitle}{isPaused ? " · paused" : routineId ? " · active/unknown" : " · not linked"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => incidentMutation.mutate({ routineTitle, routineId })}
                          disabled={incidentMutation.isPending}
                          className="rounded-full border border-red-100/20 bg-red-100/10 px-3 py-1.5 text-xs font-semibold text-red-50 transition hover:bg-red-100/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Open/update incident
                        </button>
                        {routineId ? (
                          <button
                            type="button"
                            onClick={() => pauseRoutineMutation.mutate(routineId)}
                            disabled={pauseRoutineMutation.isPending || isPaused}
                            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-red-100 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {isPaused ? "Routine paused" : "Pause routine"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {microRegistry && microSummary ? (
            <div className="overflow-hidden rounded-2xl border border-cyan-400/20 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_34%),linear-gradient(135deg,rgba(2,6,23,0.96),rgba(8,13,28,0.86))] shadow-[0_24px_80px_rgba(8,145,178,0.12)]">
              <div className="flex flex-col gap-4 border-b border-white/10 px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 p-2">
                    <FlaskConical className="h-5 w-5 text-cyan-200" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-cyan-100/70">Micro research factory</p>
                    <h2 className="mt-1 text-xl font-semibold text-white">Pod registry · evidence-gated experiments</h2>
                    <p className="mt-1 max-w-3xl text-sm text-slate-300">
                      Draft alpha work is visible here before execution. Broker actions, paid compute, overnight exposure, and promotion remain blocked until evidence and operator gates clear.
                    </p>
                    <Link
                      to="/micro-board-review"
                      className="mt-3 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-cyan-100 transition hover:bg-cyan-300/20"
                    >
                      <ClipboardCheck className="h-3.5 w-3.5" /> Open board review
                    </Link>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:min-w-[520px]">
                  {[
                    ["Pods", microSummary.pods],
                    ["Active", microSummary.activeExperiments],
                    ["Gates", microSummary.openDependencies],
                    ["Evidence", microSummary.evidencePacks],
                    ["Promote", microSummary.promotionRequests],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-center">
                      <div className="text-lg font-semibold text-white">{value}</div>
                      <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400">{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 p-4 xl:grid-cols-[1.5fr_1fr]">
                <div className="space-y-3">
                  {visibleMicroExperiments.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-white/15 p-4 text-sm text-slate-300">No registered experiments yet.</div>
                  ) : visibleMicroExperiments.map((experiment) => {
                    const pod = microRegistry.pods.find((entry) => entry.id === experiment.podId);
                    const evidence = microRegistry.evidencePacks.find((entry) => entry.experimentId === experiment.id);
                    return (
                      <div key={experiment.id} className="rounded-xl border border-white/10 bg-black/20 p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs text-cyan-200">{experiment.identifier}</span>
                              <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                                no overnight
                              </span>
                              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                                {experiment.lifecycleState}
                              </span>
                            </div>
                            <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-white">{experiment.title}</h3>
                            <p className="mt-1 line-clamp-2 text-xs text-slate-400">{experiment.hypothesis}</p>
                          </div>
                          <div className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-right">
                            <div className="text-sm font-semibold text-white">{formatExperimentWindow(experiment)}</div>
                            <div className="text-[10px] uppercase tracking-wide text-slate-400">max {experiment.maxImprovementAttempts} improvements</div>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          <span>{pod?.title ?? "Unassigned pod"}</span>
                          {evidence ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-400/10 px-2 py-1 text-cyan-100">
                              <FileText className="h-3 w-3" /> {evidence.title}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-xl border border-white/10 bg-black/20 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <LockKeyhole className="h-4 w-4 text-amber-200" />
                    <h3 className="text-sm font-semibold text-white">Open gates</h3>
                  </div>
                  {openMicroDependencies.length === 0 ? (
                    <p className="text-sm text-slate-400">No open dependency gates.</p>
                  ) : (
                    <div className="space-y-2">
                      {openMicroDependencies.map((request) => (
                        <div key={request.id} className="rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-medium text-amber-50">{request.title}</p>
                            <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-100">{request.status}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-amber-100/60">{request.description ?? request.kind}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-1 sm:gap-2">
            <MetricCard
              icon={Bot}
              value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
              label="Agents Enabled"
              to="/agents"
              description={
                <span>
                  {data.agents.running} running{", "}
                  {data.agents.paused} paused{", "}
                  {data.agents.error} errors
                </span>
              }
            />
            <MetricCard
              icon={CircleDot}
              value={data.tasks.inProgress}
              label="Tasks In Progress"
              to="/issues"
              description={
                <span>
                  {data.tasks.open} open{", "}
                  {data.tasks.blocked} blocked
                </span>
              }
            />
            <MetricCard
              icon={DollarSign}
              value={formatCents(data.costs.monthSpendCents)}
              label="Month Spend"
              to="/costs"
              description={
                <span>
                  {data.costs.monthBudgetCents > 0
                    ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                    : "Unlimited budget"}
                </span>
              }
            />
            <MetricCard
              icon={ShieldCheck}
              value={data.pendingApprovals + data.budgets.pendingApprovals}
              label="Pending Approvals"
              to="/approvals"
              description={
                <span>
                  {data.budgets.pendingApprovals > 0
                    ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                    : "Awaiting board review"}
                </span>
              }
            />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <ChartCard title="Run Activity" subtitle="Last 14 days">
              <RunActivityChart activity={data.runActivity} />
            </ChartCard>
            <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
              <PriorityChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Tasks by Status" subtitle="Last 14 days">
              <IssueStatusChart issues={issues ?? []} />
            </ChartCard>
            <ChartCard title="Success Rate" subtitle="Last 14 days">
              <SuccessRateChart activity={data.runActivity} />
            </ChartCard>
          </div>

          <PluginSlotOutlet
            slotTypes={["dashboardWidget"]}
            context={{ companyId: selectedCompanyId }}
            className="grid gap-4 md:grid-cols-2"
            itemClassName="rounded-lg border bg-card p-4 shadow-sm"
          />

          <div className="grid md:grid-cols-2 gap-4">
            {/* Recent Activity */}
            {recentActivity.length > 0 && (
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Recent Activity
                </h3>
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentActivity.map((event) => (
                    <ActivityRow
                      key={event.id}
                      event={event}
                      agentMap={agentMap}
                      userProfileMap={userProfileMap}
                      entityNameMap={entityNameMap}
                      entityTitleMap={entityTitleMap}
                      className={animatedActivityIds.has(event.id) ? "activity-row-enter" : undefined}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Recent Tasks */}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                Recent Tasks
              </h3>
              {recentIssues.length === 0 ? (
                <div className="border border-border p-4">
                  <p className="text-sm text-muted-foreground">No tasks yet.</p>
                </div>
              ) : (
                <div className="border border-border divide-y divide-border overflow-hidden">
                  {recentIssues.slice(0, 10).map((issue) => (
                    <Link
                      key={issue.id}
                      to={`/issues/${issue.identifier ?? issue.id}`}
                      className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
                    >
                      <div className="flex items-start gap-2 sm:items-center sm:gap-3">
                        {/* Status icon - left column on mobile */}
                        <span className="shrink-0 sm:hidden">
                          <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
                        </span>

                        {/* Right column on mobile: title + metadata stacked */}
                        <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
                          <span className="line-clamp-2 text-sm sm:order-2 sm:flex-1 sm:min-w-0 sm:line-clamp-none sm:truncate">
                            {issue.title}
                          </span>
                          <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
                            <span className="hidden sm:inline-flex"><StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} /></span>
                            <span className="text-xs font-mono text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {issue.assigneeAgentId && (() => {
                              const name = agentName(issue.assigneeAgentId);
                              return name
                                ? <span className="hidden sm:inline-flex"><Identity name={name} size="sm" /></span>
                                : null;
                            })()}
                            <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
                            <span className="text-xs text-muted-foreground shrink-0 sm:order-last">
                              {timeAgo(issue.updatedAt)}
                            </span>
                          </span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
