import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { approvalsApi } from "../api/approvals";
import { heartbeatsApi } from "../api/heartbeats";
import { routinesApi } from "../api/routines";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { StatusIcon } from "../components/StatusIcon";

import { ActivityRow } from "../components/ActivityRow";
import { Identity } from "../components/Identity";
import { timeAgo } from "../lib/timeAgo";
import { cn, formatCents } from "../lib/utils";
import {
  AlertTriangle,
  Archive,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDot,
  Clock3,
  DollarSign,
  FileStack,
  LayoutDashboard,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import { ActiveAgentsPanel } from "../components/ActiveAgentsPanel";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import type {
  Agent,
  Approval,
  HeartbeatRun,
  Issue,
  IssueWorkProduct,
  Project,
  RoutineListItem,
} from "@paperclipai/shared";
import { PluginSlotOutlet } from "@/plugins/slots";

const DASHBOARD_ACTIVITY_LIMIT = 10;
const WORK_SURFACE_ITEM_LIMIT = 4;
const WORK_SURFACE_ARTIFACT_ISSUE_LIMIT = 6;

function getRecentIssues(issues: Issue[]): Issue[] {
  return [...issues]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function getItemTime(value: string | Date | null | undefined) {
  return value ? timeAgo(value) : "No activity";
}

function getIssueHref(issue: Pick<Issue, "id" | "identifier">) {
  return `/issues/${issue.identifier ?? issue.id}`;
}

function isIssueOpen(issue: Issue) {
  return !["done", "cancelled"].includes(issue.status);
}

function isBlockerIssue(issue: Issue) {
  return issue.status === "blocked" ||
    Boolean(issue.blockerAttention?.state && issue.blockerAttention.state !== "none");
}

function issueStatusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function WorkSurfaceSection({
  projects,
  issues,
  routines,
  approvals,
  runs,
  artifacts,
  loading,
  errorMessage,
}: {
  projects?: Project[];
  issues?: Issue[];
  routines?: RoutineListItem[];
  approvals?: Approval[];
  runs?: HeartbeatRun[];
  artifacts: IssueWorkProduct[];
  loading: boolean;
  errorMessage: string | null;
}) {
  const activeProjects = (projects ?? []).filter((project) => !project.archivedAt).slice(0, WORK_SURFACE_ITEM_LIMIT);
  const openIssues = (issues ?? []).filter(isIssueOpen).slice(0, WORK_SURFACE_ITEM_LIMIT);
  const blockerIssues = (issues ?? []).filter(isBlockerIssue).slice(0, WORK_SURFACE_ITEM_LIMIT);
  const activeRoutines = (routines ?? [])
    .filter((routine) => routine.status !== "archived")
    .slice(0, WORK_SURFACE_ITEM_LIMIT);
  const pendingApprovals = (approvals ?? [])
    .filter((approval) => ["pending", "pending_approval"].includes(approval.status))
    .slice(0, WORK_SURFACE_ITEM_LIMIT);
  const recentRuns = (runs ?? []).slice(0, WORK_SURFACE_ITEM_LIMIT);
  const recentArtifacts = artifacts.slice(0, WORK_SURFACE_ITEM_LIMIT);
  const reviewArtifacts = artifacts.filter((artifact) => artifact.reviewState !== "none" || artifact.isPrimary);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Work Surface</h2>
          <p className="text-sm text-muted-foreground">
            One scan for active work, blockers, approvals, execution, and evidence.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <Link to="/projects" className="underline underline-offset-2">Projects</Link>
          <Link to="/issues" className="underline underline-offset-2">Issues</Link>
          <Link to="/routines" className="underline underline-offset-2">Routines</Link>
          <Link to="/approvals" className="underline underline-offset-2">Approvals</Link>
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        <WorkSurfacePanel
          icon={BriefcaseBusiness}
          title="Projects"
          count={projects?.filter((project) => !project.archivedAt).length ?? 0}
          href="/projects"
          loading={loading && !projects}
          empty="No active projects."
        >
          {activeProjects.map((project) => (
            <WorkSurfaceRow
              key={project.id}
              href={`/projects/${project.id}`}
              title={project.name}
              meta={project.status}
              time={getItemTime(project.updatedAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={CircleDot}
          title="Issues"
          count={(issues ?? []).filter(isIssueOpen).length}
          href="/issues"
          loading={loading && !issues}
          empty="No open issues."
        >
          {openIssues.map((issue) => (
            <WorkSurfaceRow
              key={issue.id}
              href={getIssueHref(issue)}
              title={issue.title}
              meta={`${issue.identifier ?? issue.id.slice(0, 8)} · ${issueStatusLabel(issue.status)}`}
              time={getItemTime(issue.updatedAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={AlertTriangle}
          title="Blockers"
          count={(issues ?? []).filter(isBlockerIssue).length}
          href="/issues?status=blocked"
          loading={loading && !issues}
          empty="No blockers surfaced."
          tone={blockerIssues.length > 0 ? "warning" : "default"}
        >
          {blockerIssues.map((issue) => (
            <WorkSurfaceRow
              key={issue.id}
              href={getIssueHref(issue)}
              title={issue.title}
              meta={issue.identifier ?? issue.id.slice(0, 8)}
              time={getItemTime(issue.updatedAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={Clock3}
          title="Routines"
          count={(routines ?? []).length}
          href="/routines"
          loading={loading && !routines}
          empty="No routines configured."
        >
          {activeRoutines.map((routine) => (
            <WorkSurfaceRow
              key={routine.id}
              href={`/routines/${routine.id}`}
              title={routine.title}
              meta={routine.lastRun ? `Last ${routine.lastRun.status}` : `${routine.triggers.length} triggers`}
              time={getItemTime(routine.lastRun?.createdAt ?? routine.updatedAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={ShieldCheck}
          title="Approvals"
          count={pendingApprovals.length}
          href="/approvals"
          loading={loading && !approvals}
          empty="No pending approvals."
          tone={pendingApprovals.length > 0 ? "warning" : "default"}
        >
          {pendingApprovals.map((approval) => (
            <WorkSurfaceRow
              key={approval.id}
              href={`/approvals/${approval.id}`}
              title={approval.type.replaceAll("_", " ")}
              meta={approval.status.replaceAll("_", " ")}
              time={getItemTime(approval.createdAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={PlayCircle}
          title="Runs"
          count={(runs ?? []).length}
          href="/inbox"
          loading={loading && !runs}
          empty="No recent runs."
        >
          {recentRuns.map((run) => (
            <WorkSurfaceRow
              key={run.id}
              href={`/agents/${run.agentId}/runs/${run.id}`}
              title={run.status.replaceAll("_", " ")}
              meta={run.invocationSource.replaceAll("_", " ")}
              time={getItemTime(run.startedAt ?? run.createdAt)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={FileStack}
          title="Artifacts"
          count={artifacts.length}
          href="/issues"
          loading={loading}
          empty="No recent artifacts."
        >
          {recentArtifacts.map((artifact) => (
            <WorkSurfaceRow
              key={artifact.id}
              href={artifact.url ?? getIssueHref({ id: artifact.issueId, identifier: null })}
              title={artifact.title}
              meta={`${artifact.type.replaceAll("_", " ")} · ${artifact.status.replaceAll("_", " ")}`}
              time={getItemTime(artifact.updatedAt)}
              external={Boolean(artifact.url)}
            />
          ))}
        </WorkSurfacePanel>

        <WorkSurfacePanel
          icon={Archive}
          title="Evidence"
          count={reviewArtifacts.length}
          href="/issues"
          loading={loading}
          empty="No review evidence."
        >
          {reviewArtifacts
            .slice(0, WORK_SURFACE_ITEM_LIMIT)
            .map((artifact) => (
              <WorkSurfaceRow
                key={artifact.id}
                href={artifact.url ?? getIssueHref({ id: artifact.issueId, identifier: null })}
                title={artifact.title}
                meta={artifact.reviewState.replaceAll("_", " ")}
                time={getItemTime(artifact.updatedAt)}
                external={Boolean(artifact.url)}
              />
            ))}
        </WorkSurfacePanel>
      </div>
    </section>
  );
}

function WorkSurfacePanel({
  icon: Icon,
  title,
  count,
  href,
  loading,
  empty,
  tone = "default",
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  count: number;
  href: string;
  loading: boolean;
  empty: string;
  tone?: "default" | "warning";
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);

  return (
    <div className={cn(
      "min-w-0 rounded-lg border bg-card",
      tone === "warning" ? "border-amber-400/35" : "border-border",
    )}>
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("h-4 w-4 shrink-0", tone === "warning" ? "text-amber-500" : "text-muted-foreground")} />
          <h3 className="truncate text-sm font-semibold">{title}</h3>
        </div>
        <Link
          to={href}
          className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground no-underline"
        >
          {count}
        </Link>
      </div>
      <div className="divide-y divide-border">
        {loading ? (
          <div className="space-y-2 p-3">
            <div className="h-3 w-3/4 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
        ) : hasChildren ? (
          children
        ) : (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{empty}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkSurfaceRow({
  href,
  title,
  meta,
  time,
  external = false,
}: {
  href: string;
  title: string;
  meta: string;
  time: string;
  external?: boolean;
}) {
  const className = "block min-w-0 px-3 py-2.5 text-sm no-underline text-inherit hover:bg-accent/50";
  const content = (
    <>
      <div className="truncate font-medium">{title}</div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate capitalize">{meta}</span>
        <span className="shrink-0">{time}</span>
      </div>
    </>
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {content}
      </a>
    );
  }

  return (
    <Link to={href} className={className}>
      {content}
    </Link>
  );
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
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

  const {
    data: routines,
    isLoading: areRoutinesLoading,
    error: routinesError,
  } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: approvals,
    isLoading: areApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const {
    data: runs,
    isLoading: areRunsLoading,
    error: runsError,
  } = useQuery({
    queryKey: ["dashboard", selectedCompanyId, "recent-runs", WORK_SURFACE_ITEM_LIMIT * 2],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, WORK_SURFACE_ITEM_LIMIT * 2),
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
  const artifactIssueIds = useMemo(
    () => recentIssues.slice(0, WORK_SURFACE_ARTIFACT_ISSUE_LIMIT).map((issue) => issue.id),
    [recentIssues],
  );
  const issueDetailQueries = useQueries({
    queries: artifactIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      enabled: !!selectedCompanyId,
    })),
  });
  const workSurfaceArtifacts = useMemo(
    () => issueDetailQueries
      .flatMap((query) => query.data?.workProducts ?? [])
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [issueDetailQueries],
  );
  const workSurfaceError = [
    routinesError,
    approvalsError,
    runsError,
    ...issueDetailQueries.map((query) => query.error),
  ].find(Boolean);
  const workSurfaceErrorMessage = workSurfaceError instanceof Error
    ? workSurfaceError.message
    : workSurfaceError
      ? "Some Work Surface data could not be loaded."
      : null;
  const isWorkSurfaceLoading =
    !issues ||
    !projects ||
    areRoutinesLoading ||
    areApprovalsLoading ||
    areRunsLoading ||
    issueDetailQueries.some((query) => query.isLoading);

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

          <WorkSurfaceSection
            projects={projects}
            issues={issues}
            routines={routines}
            approvals={approvals}
            runs={runs}
            artifacts={workSurfaceArtifacts}
            loading={isWorkSurfaceLoading}
            errorMessage={workSurfaceErrorMessage}
          />

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
