import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleDot, Clock, GitBranch, MessageSquareWarning, Route, ShieldAlert, Zap, type LucideIcon } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { buildCommandCenterTrace, enrichCommandCenterWithLiveRuns, formatCommandCenterStatusLabel, type CommandCenterGateTone, type CommandCenterWorkstreamKind } from "../lib/command-center";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { cn, issueUrl, projectUrl } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";

const gateToneClass: Record<CommandCenterGateTone, string> = {
  queued: "border-border bg-muted/40 text-muted-foreground",
  running: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  approval: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  guardrail: "border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300",
  stale: "border-orange-500/35 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  complete: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

const gateToneIcon: Record<CommandCenterGateTone, LucideIcon> = {
  queued: Clock,
  running: Zap,
  approval: MessageSquareWarning,
  guardrail: ShieldAlert,
  stale: AlertTriangle,
  complete: CheckCircle2,
};

const handoffDotClass: Record<CommandCenterGateTone, string> = {
  queued: "bg-muted-foreground/40",
  running: "bg-blue-500",
  approval: "bg-amber-500",
  guardrail: "bg-red-500",
  stale: "bg-orange-500",
  complete: "bg-emerald-500",
};

const workstreamClass: Record<CommandCenterWorkstreamKind, string> = {
  real_work_now: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  automation_supervision: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  administrative_mirror: "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
};

export function CommandCenter() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Centro de comando" }]);
  }, [setBreadcrumbs]);

  const { data: projects, isLoading: projectsLoading, error: projectsError } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues, isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "command-center"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 500 }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents, isLoading: agentsLoading, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns, error: liveRunsError } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "command-center"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const trace = useMemo(
    () => enrichCommandCenterWithLiveRuns(
      buildCommandCenterTrace({
        projects: projects ?? [],
        issues: issues ?? [],
        agents: agents ?? [],
      }),
      liveRuns ?? [],
    ),
    [projects, issues, agents, liveRuns],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Selecione uma empresa para ver o centro de comando." />;
  }

  if (projectsLoading || issuesLoading || agentsLoading) {
    return <PageSkeleton variant="command-center" />;
  }

  const error = projectsError ?? issuesError ?? agentsError ?? liveRunsError;

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Centro de comando Paperclip</p>
            <h1 className="mt-1 text-2xl font-semibold">Cockpit de rastreabilidade visual</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Visão somente leitura de projetos, agentes, branches, runs reais, supervisão e portões de aprovação.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
            <Metric label="Trabalho real agora" value={trace.realWorkNowCount} />
            <Metric label="Automação/supervisão" value={trace.automationSupervisionCount} />
            <Metric label="Espelhos administrativos" value={trace.administrativeMirrorCount} />
            <Metric label="Portões JP" value={trace.reviewGateCount} tone="warning" />
            <Metric label="Guardrails" value={trace.guardrailCount} tone="danger" />
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Dados do centro de comando indisponíveis temporariamente. Atualize ou tente novamente em instantes.
        </div>
      ) : null}

      {!error && trace.totalActiveIssues === 0 ? (
        <EmptyState icon={CircleDot} message="Nenhuma issue ativa para rastrear. Crie ou reabra trabalho para preencher o centro de comando." />
      ) : null}

      {trace.groups.map((group) => (
        <section key={group.projectId ?? "unscoped"} className="rounded-lg border border-border bg-card">
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                {group.projectId ? (
                  <Link className="font-semibold hover:underline" to={projectUrl({ id: group.projectId, name: group.projectName })}>
                    {group.projectName}
                  </Link>
                ) : (
                  <h2 className="font-semibold">{group.projectName}</h2>
                )}
                {group.projectStatus ? <StatusBadge status={group.projectStatus} label={formatCommandCenterStatusLabel(group.projectStatus)} /> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{group.activeIssueCount} issue{group.activeIssueCount === 1 ? "" : "s"} ativa{group.activeIssueCount === 1 ? "" : "s"}</p>
            </div>
          </div>

          <div className="divide-y divide-border">
            {group.issues.map((issue) => {
              const GateIcon = gateToneIcon[issue.gate.tone];
              const priorityTone = priorityColor[issue.priority as keyof typeof priorityColor] ?? priorityColorDefault;

              return (
                <article key={issue.id} className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(160px,0.7fr)_minmax(220px,1fr)]">
                  <div className="order-2 min-w-0 lg:order-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link className="font-medium hover:underline" to={issueUrl(issue)}>
                        {issue.identifier}
                      </Link>
                      <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground" title={issue.projectDisplayLabel}>
                        {issue.projectName}
                      </span>
                      <StatusBadge status={issue.status} label={formatCommandCenterStatusLabel(issue.status)} />
                      <span className={cn("rounded-full border border-border bg-background/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", priorityTone)}>
                        {formatPriority(issue.priority)}
                      </span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", workstreamClass[issue.workstream.kind])} title={issue.workstream.detail}>
                        {issue.workstream.label}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-foreground">{issue.title}</p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {issue.agentId && issue.gate.tone === "running" ? (
                        <span aria-label="Agente em execução" className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400 animate-pulse" />
                      ) : null}
                      Responsável: {issue.responsible}
                      {issue.squadRole ? ` · Papel: ${issue.squadRole.label}` : ""}
                    </p>
                    {issue.squadRole ? (
                      <p className="mt-0.5 text-xs text-muted-foreground/70">
                        {issue.squadRole.internal ? "Raia interna" : "Portão externo"}: {issue.squadRole.scope}
                      </p>
                    ) : null}
                    <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground/70">
                      <Clock className="h-3 w-3 flex-shrink-0" aria-hidden />
                      {formatElapsed(issue.updatedAt)}
                    </p>
                  </div>

                  <div className="order-3 space-y-3 text-xs text-muted-foreground lg:order-2">
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <GitBranch className="h-3.5 w-3.5" />
                        Branch / workspace
                      </div>
                      <p className="mt-1 break-all">{issue.branchOrWorkspace ?? "Nenhuma branch ou workspace vinculado"}</p>
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <Route className="h-3.5 w-3.5" />
                        Trilha de bastão
                      </div>
                      <ol className="mt-2 space-y-1.5">
                        {issue.handoffTrail.map((step, index) => (
                          <li key={`${issue.id}-handoff-${index}`} className="flex gap-2">
                            <span className={cn("mt-1 h-2 w-2 flex-shrink-0 rounded-full", handoffDotClass[step.tone])} aria-hidden />
                            <span className="min-w-0">
                              <span className="font-medium text-foreground">{step.label}</span>
                              <span className="text-muted-foreground"> · {step.detail}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </div>

                  <div className={cn("order-1 rounded-md border px-3 py-2 text-xs lg:order-3", gateToneClass[issue.gate.tone])}>
                    <div className="flex items-center gap-1.5 font-semibold">
                      <GateIcon className={cn("h-3.5 w-3.5", issue.gate.tone === "running" && "animate-pulse")} />
                      {issue.gate.label}
                    </div>
                    <p className="mt-1 leading-relaxed">{issue.gate.nextAction}</p>
                    {issue.liveRun ? (
                      <div className="mt-2 rounded border border-current/20 bg-background/40 px-2 py-1.5">
                        <div className="font-semibold">Execução real: {issue.liveRun.agentName}</div>
                        <div className="mt-0.5 break-all text-[11px] opacity-90">
                          {issue.liveRun.runId} · {issue.liveRun.adapterType} · {formatLiveRunStatus(issue.liveRun.status)}/{formatLivenessState(issue.liveRun.livenessState)}
                        </div>
                        {issue.liveRun.elapsedMs !== null ? <div className="mt-0.5 text-[11px] opacity-90">Ativa há {formatDuration(issue.liveRun.elapsedMs)}</div> : null}
                      </div>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

type MetricTone = "default" | "warning" | "danger";

const metricValueClass: Record<MetricTone, string> = {
  default: "text-foreground",
  warning: "text-amber-700 dark:text-amber-300",
  danger: "text-red-700 dark:text-red-300",
};

function formatPriority(priority: string): string {
  const labels: Record<string, string> = {
    low: "baixa",
    medium: "média",
    high: "alta",
    critical: "crítica",
  };
  return labels[priority] ?? priority;
}

function formatElapsed(updatedAt: Date | string): string {
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 2) return "agora mesmo";
  if (minutes < 60) return `há ${minutes} min`;

  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `há ${hours} h`;

  const days = Math.floor(ms / 86_400_000);
  return `há ${days} d`;
}

function formatDuration(ms: number): string {
  if (ms < 0 || Number.isNaN(ms)) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} h ${remainingMinutes} min` : `${hours} h`;
}

function formatLiveRunStatus(status: string | null | undefined): string {
  if (!status) return "status desconhecido";
  const labels: Record<string, string> = {
    queued: "na fila",
    running: "rodando",
    succeeded: "concluída",
    failed: "falhou",
    cancelled: "cancelada",
  };
  return labels[status] ?? status;
}

function formatLivenessState(state: string | null | undefined): string {
  if (!state) return "sem estado";
  const labels: Record<string, string> = {
    new: "nova",
    advanced: "avançando",
    stale: "sem avanço",
    missing: "sem heartbeat",
  };
  return labels[state] ?? state;
}

function Metric({ label, value, tone = "default" }: { label: string; value: number; tone?: MetricTone }) {
  return (
    <div className="min-w-20 rounded-md border border-border bg-background px-3 py-2 shadow-sm">
      <div className={cn("text-2xl font-bold leading-none", metricValueClass[tone])}>{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
