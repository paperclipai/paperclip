import { useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogActions } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildCompanyUserLabelMap } from "../lib/company-members";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import {
  createIssueDetailLocationState,
  createIssueDetailPath,
  withIssueDetailHeaderSeed,
} from "../lib/issueDetailBreadcrumb";
import { cn, formatShortDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import {
  AlertCircle,
  Bot,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Gauge,
  ListChecks,
  Plus,
  Target,
  Users,
} from "lucide-react";
import type { InboxIssueColumn } from "../lib/inbox";
import type { Agent, Issue, IssuePriority, IssueStatus, IssueWorkItemType, Project } from "@paperclipai/shared";

const WORK_HUB_PAGE_SIZE = 500;
const WORK_HUB_HUMAN_WORK_ITEM_TYPES = ["initiative", "human_task"] as const satisfies readonly IssueWorkItemType[];
const WORK_HUB_DASHBOARD_ITEM_TYPES = ["initiative", "human_task", "ai_task"] as const satisfies readonly IssueWorkItemType[];
const WORK_HUB_OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const WORK_HUB_DEFAULT_COLUMNS: InboxIssueColumn[] = [
  "status",
  "id",
  "assignee",
  "project",
  "priority",
  "dueDate",
  "labels",
  "updated",
];

const PRIORITY_POINTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

type WorkItemFilter = "all" | "initiative" | "human_task" | "execution";

type WorkHubFilterConfig = {
  label: string;
  shortLabel: string;
  icon: typeof BriefcaseBusiness;
  workItemTypes: readonly IssueWorkItemType[];
};

const FILTER_CONFIG: Record<WorkItemFilter, WorkHubFilterConfig> = {
  all: {
    label: "Human Work",
    shortLabel: "Human",
    icon: BriefcaseBusiness,
    workItemTypes: WORK_HUB_HUMAN_WORK_ITEM_TYPES,
  },
  human_task: {
    label: "Human Tasks",
    shortLabel: "Tasks",
    icon: Users,
    workItemTypes: ["human_task"],
  },
  initiative: {
    label: "Initiatives",
    shortLabel: "Initiatives",
    icon: Target,
    workItemTypes: ["initiative"],
  },
  execution: {
    label: "AI Issues",
    shortLabel: "AI",
    icon: Bot,
    workItemTypes: ["ai_task"],
  },
};

type MetricTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

type WorkloadRow = {
  id: string;
  label: string;
  count: number;
  points: number;
  blocked: number;
  dueSoon: number;
  projectCount: number;
};

type ProjectPulseRow = {
  id: string;
  name: string;
  href: string | null;
  color: string | null;
  status: string | null;
  active: number;
  done: number;
  total: number;
  blocked: number;
  points: number;
  targetDate: string | null;
  progress: number;
};

type TimelineRow = {
  id: string;
  label: string;
  meta: string;
  href: string | null;
  state?: unknown;
  date: string | Date;
  status: IssueStatus | Project["status"];
  kind: "task" | "project";
};

type WorkHubDashboardSummary = {
  humanTaskCount: number;
  initiativeCount: number;
  executionIssueCount: number;
  openHumanTaskCount: number;
  blockedCount: number;
  unassignedCount: number;
  overdueCount: number;
  dueSoonCount: number;
  completionPct: number;
  planningPoints: number;
  laneCounts: Record<WorkItemFilter, number>;
  workload: WorkloadRow[];
  projectPulse: ProjectPulseRow[];
  timeline: TimelineRow[];
};

function mergeIssuePagesStable(pages: Issue[][]): Issue[] {
  const seen = new Set<string>();
  const merged: Issue[] = [];
  for (const page of pages) {
    for (const issue of page) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      merged.push(issue);
    }
  }
  return merged;
}

function getNextPageOffset(loaded: number, offset: number): number | undefined {
  return loaded >= WORK_HUB_PAGE_SIZE ? offset + WORK_HUB_PAGE_SIZE : undefined;
}

function isOpenWork(issue: Issue): boolean {
  return WORK_HUB_OPEN_STATUSES.has(issue.status);
}

function isDoneWork(issue: Issue): boolean {
  return issue.status === "done";
}

function planningPointsForIssue(issue: Issue): number {
  return PRIORITY_POINTS[issue.priority] ?? 1;
}

function startOfLocalDay(input: Date | string): number {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dueDistanceLabel(date: Date | string): string {
  const today = startOfLocalDay(new Date());
  const due = startOfLocalDay(date);
  const days = Math.round((due - today) / DAY_MS);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 7) return `${days}d`;
  return formatShortDate(date);
}

function isDueWithin(issue: Issue, days: number): boolean {
  if (!issue.dueDate || !isOpenWork(issue)) return false;
  const due = startOfLocalDay(issue.dueDate);
  const today = startOfLocalDay(new Date());
  return due >= today && due <= today + days * DAY_MS;
}

function isOverdue(issue: Issue): boolean {
  if (!issue.dueDate || !isOpenWork(issue)) return false;
  return startOfLocalDay(issue.dueDate) < startOfLocalDay(new Date());
}

function issuePathId(issue: Issue): string {
  return issue.identifier ?? issue.id;
}

function humanAssigneeLabel(
  userId: string | null,
  currentUserId: string | null,
  userLabelMap: ReadonlyMap<string, string>,
): string {
  if (!userId) return "Unassigned";
  return formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ?? "User";
}

function createEmptyDashboard(): WorkHubDashboardSummary {
  return {
    humanTaskCount: 0,
    initiativeCount: 0,
    executionIssueCount: 0,
    openHumanTaskCount: 0,
    blockedCount: 0,
    unassignedCount: 0,
    overdueCount: 0,
    dueSoonCount: 0,
    completionPct: 0,
    planningPoints: 0,
    laneCounts: {
      all: 0,
      human_task: 0,
      initiative: 0,
      execution: 0,
    },
    workload: [],
    projectPulse: [],
    timeline: [],
  };
}

function buildWorkHubDashboard(args: {
  issues: Issue[];
  projects: Project[] | undefined;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string>;
  issueLinkState: unknown;
}): WorkHubDashboardSummary {
  const summary = createEmptyDashboard();
  const projectById = new Map((args.projects ?? []).map((project) => [project.id, project]));

  const humanTasks = args.issues.filter((issue) => issue.workItemType === "human_task");
  const initiatives = args.issues.filter((issue) => issue.workItemType === "initiative");
  const executionIssues = args.issues.filter((issue) => issue.workItemType === "ai_task");
  const humanPlanningItems = [...humanTasks, ...initiatives];
  const openHumanTasks = humanTasks.filter(isOpenWork);

  summary.humanTaskCount = humanTasks.length;
  summary.initiativeCount = initiatives.length;
  summary.executionIssueCount = executionIssues.length;
  summary.openHumanTaskCount = openHumanTasks.length;
  summary.blockedCount = humanPlanningItems.filter((issue) => issue.status === "blocked").length;
  summary.unassignedCount = openHumanTasks.filter((issue) => !issue.assigneeUserId).length;
  summary.overdueCount = humanPlanningItems.filter(isOverdue).length;
  summary.dueSoonCount = humanPlanningItems.filter((issue) => isDueWithin(issue, 7)).length;
  summary.planningPoints = openHumanTasks.reduce((total, issue) => total + planningPointsForIssue(issue), 0);
  summary.completionPct = humanTasks.length > 0
    ? Math.round((humanTasks.filter(isDoneWork).length / humanTasks.length) * 100)
    : 0;
  summary.laneCounts = {
    all: humanPlanningItems.length,
    human_task: humanTasks.length,
    initiative: initiatives.length,
    execution: executionIssues.length,
  };

  const workloadByOwner = new Map<string, WorkloadRow & { projectIds: Set<string> }>();
  for (const issue of openHumanTasks) {
    const ownerId = issue.assigneeUserId ?? "__unassigned";
    const row = workloadByOwner.get(ownerId) ?? {
      id: ownerId,
      label: humanAssigneeLabel(issue.assigneeUserId, args.currentUserId, args.userLabelMap),
      count: 0,
      points: 0,
      blocked: 0,
      dueSoon: 0,
      projectCount: 0,
      projectIds: new Set<string>(),
    };
    row.count += 1;
    row.points += planningPointsForIssue(issue);
    if (issue.status === "blocked") row.blocked += 1;
    if (isDueWithin(issue, 7) || isOverdue(issue)) row.dueSoon += 1;
    row.projectIds.add(issue.projectId ?? "__no_project");
    row.projectCount = row.projectIds.size;
    workloadByOwner.set(ownerId, row);
  }

  summary.workload = [...workloadByOwner.values()]
    .map(({ projectIds: _projectIds, ...row }) => row)
    .sort((a, b) => b.points - a.points || b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 6);

  const pulseByProject = new Map<string, ProjectPulseRow>();
  for (const issue of humanPlanningItems) {
    const project = issue.projectId ? projectById.get(issue.projectId) ?? issue.project ?? null : null;
    const id = issue.projectId ?? "__no_project";
    const row = pulseByProject.get(id) ?? {
      id,
      name: project?.name ?? issue.project?.name ?? "No project",
      href: project ? projectUrl(project) : null,
      color: project?.color ?? issue.project?.color ?? null,
      status: project?.status ?? issue.project?.status ?? null,
      active: 0,
      done: 0,
      total: 0,
      blocked: 0,
      points: 0,
      targetDate: project?.targetDate ?? issue.project?.targetDate ?? null,
      progress: 0,
    };
    row.total += 1;
    if (isOpenWork(issue)) row.active += 1;
    if (isDoneWork(issue)) row.done += 1;
    if (issue.status === "blocked") row.blocked += 1;
    if (issue.workItemType === "human_task" && isOpenWork(issue)) row.points += planningPointsForIssue(issue);
    row.progress = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
    pulseByProject.set(id, row);
  }

  summary.projectPulse = [...pulseByProject.values()]
    .sort((a, b) => b.blocked - a.blocked || b.active - a.active || b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, 5);

  const issueDeadlines: TimelineRow[] = humanPlanningItems
    .filter((issue) => issue.dueDate && isOpenWork(issue))
    .map((issue) => ({
      id: `issue:${issue.id}`,
      label: issue.title,
      meta: issue.workItemType === "initiative"
        ? "Initiative"
        : `${humanAssigneeLabel(issue.assigneeUserId, args.currentUserId, args.userLabelMap)} task`,
      href: createIssueDetailPath(issuePathId(issue)),
      state: withIssueDetailHeaderSeed(args.issueLinkState, issue),
      date: issue.dueDate!,
      status: issue.status,
      kind: "task" as const,
    }));

  const projectDeadlines: TimelineRow[] = (args.projects ?? [])
    .filter((project) => !project.archivedAt && project.targetDate)
    .map((project) => ({
      id: `project:${project.id}`,
      label: project.name,
      meta: "Project target",
      href: projectUrl(project),
      date: project.targetDate!,
      status: project.status,
      kind: "project" as const,
    }));

  summary.timeline = [...issueDeadlines, ...projectDeadlines]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, 6);

  return summary;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral",
}: {
  icon: typeof BriefcaseBusiness;
  label: string;
  value: string | number;
  detail: string;
  tone?: MetricTone;
}) {
  const toneClasses: Record<MetricTone, string> = {
    neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    amber: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    red: "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    violet: "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300",
  };

  return (
    <div className="rounded-md border border-border bg-background px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-2 text-2xl font-semibold leading-none text-foreground">{value}</div>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md", toneClasses[tone])}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function LaneButton({
  config,
  count,
  isActive,
  onClick,
}: {
  config: WorkHubFilterConfig;
  count: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const Icon = config.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors",
        isActive
          ? "border-foreground bg-foreground text-background shadow-sm"
          : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">{config.label}</span>
      <span className="sm:hidden">{config.shortLabel}</span>
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-[10px] tabular-nums",
          isActive ? "bg-background/15 text-background" : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function WorkloadPanel({ rows }: { rows: WorkloadRow[] }) {
  const maxPoints = Math.max(1, ...rows.map((row) => row.points));

  return (
    <section className="rounded-md border border-border bg-background p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Workload</h2>
          <p className="text-xs text-muted-foreground">Human task load by owner</p>
        </div>
        <Gauge className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-4 space-y-3">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No open human tasks.
          </div>
        ) : rows.map((row) => (
          <div key={row.id} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-medium text-foreground">{row.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {row.points} pts / {row.count} tasks
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-muted">
              <div
                className={cn(
                  "h-full rounded bg-foreground",
                  row.blocked > 0 && "bg-rose-500",
                  row.blocked === 0 && row.dueSoon > 0 && "bg-amber-500",
                )}
                style={{ width: `${Math.max(8, Math.round((row.points / maxPoints) * 100))}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span>{row.projectCount} projects</span>
              <span>{row.dueSoon} due soon</span>
              <span>{row.blocked} blocked</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectPulsePanel({ rows }: { rows: ProjectPulseRow[] }) {
  return (
    <section className="rounded-md border border-border bg-background p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Project Pulse</h2>
          <p className="text-xs text-muted-foreground">Open work, blockers, and targets</p>
        </div>
        <CircleDot className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-4 divide-y divide-border">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No project work yet.
          </div>
        ) : rows.map((row) => {
          const content = (
            <div className="flex items-center gap-3 py-3">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: row.color ?? "currentColor" }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.progress}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                  <div className="h-full rounded bg-emerald-500" style={{ width: `${row.progress}%` }} />
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{row.active} open</span>
                  <span>{row.blocked} blocked</span>
                  <span>{row.points} pts</span>
                  {row.targetDate ? <span>{dueDistanceLabel(row.targetDate)}</span> : null}
                </div>
              </div>
            </div>
          );

          return row.href ? (
            <Link key={row.id} to={row.href} className="block hover:bg-muted/40">
              {content}
            </Link>
          ) : (
            <div key={row.id}>{content}</div>
          );
        })}
      </div>
    </section>
  );
}

function TimelinePanel({ rows }: { rows: TimelineRow[] }) {
  return (
    <section className="rounded-md border border-border bg-background p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Timeline</h2>
          <p className="text-xs text-muted-foreground">Upcoming due dates and project targets</p>
        </div>
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-4 space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No dated work.
          </div>
        ) : rows.map((row) => {
          const content = (
            <div className="grid grid-cols-[4.75rem_1fr] gap-3 rounded-md border border-border bg-background px-3 py-2 hover:bg-muted/40">
              <div className={cn(
                "text-xs font-semibold tabular-nums",
                startOfLocalDay(row.date) < startOfLocalDay(new Date()) ? "text-rose-600 dark:text-rose-400" : "text-foreground",
              )}>
                {dueDistanceLabel(row.date)}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{row.label}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{row.meta}</span>
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
                  <span>{row.status.replaceAll("_", " ")}</span>
                </div>
              </div>
            </div>
          );

          return row.href ? (
            <Link key={row.id} to={row.href} state={row.state} className="block">
              {content}
            </Link>
          ) : (
            <div key={row.id}>{content}</div>
          );
        })}
      </div>
    </section>
  );
}

export function WorkHub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchNextPageInFlightRef = useRef(false);

  const filterParam = searchParams.get("filter");
  const activeFilter: WorkItemFilter = filterParam === "all"
    || filterParam === "initiative"
    || filterParam === "human_task"
    || filterParam === "execution"
    ? filterParam
    : "all";
  const filterConfig = FILTER_CONFIG[activeFilter];
  const workItemTypeParam = filterConfig.workItemTypes.join(",");
  const createWorkItemType: IssueWorkItemType = activeFilter === "initiative"
    ? "initiative"
    : activeFilter === "execution"
      ? "ai_task"
      : "human_task";
  const createIssueLabel = activeFilter === "initiative"
    ? "Initiative"
    : activeFilter === "execution"
      ? "Execution Issue"
      : "Human Task";

  useEffect(() => {
    setBreadcrumbs([{ label: "Work Hub" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const { data: companyUserDirectory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyUserDirectory?.users),
    [companyUserDirectory?.users],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const issueLinkState = useMemo(
    () => createIssueDetailLocationState("Work Hub", "/work", "issues"),
    [],
  );

  const { data: dashboardIssues = [] } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "work-hub-dashboard",
      WORK_HUB_DASHBOARD_ITEM_TYPES.join(","),
      WORK_HUB_PAGE_SIZE,
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      excludeRoutineExecutions: true,
      workItemType: WORK_HUB_DASHBOARD_ITEM_TYPES.join(","),
      limit: WORK_HUB_PAGE_SIZE,
    }),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const dashboard = useMemo(
    () => buildWorkHubDashboard({
      issues: dashboardIssues,
      projects,
      agents,
      currentUserId,
      userLabelMap,
      issueLinkState,
    }),
    [agents, currentUserId, dashboardIssues, issueLinkState, projects, userLabelMap],
  );

  const {
    data: issuePages,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "work-hub",
      activeFilter,
      WORK_HUB_PAGE_SIZE,
    ],
    queryFn: ({ pageParam }) => issuesApi.list(selectedCompanyId!, {
      participantAgentId: undefined,
      workspaceId: undefined,
      excludeRoutineExecutions: true,
      workItemType: workItemTypeParam,
      limit: WORK_HUB_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextPageOffset(lastPage.length, lastPageParam),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const issues = useMemo(() => mergeIssuePagesStable((issuePages as any)?.pages ?? []), [issuePages]);
  const hasMore = hasNextPage === true;

  const loadMoreIssues = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || fetchNextPageInFlightRef.current) return;
    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      fetchNextPageInFlightRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update issue",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BriefcaseBusiness} message="Select a company to view the Work Hub." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BriefcaseBusiness className="h-4 w-4 text-muted-foreground" />
              <h1 className="truncate text-lg font-semibold text-foreground">Work Hub</h1>
            </div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              Human coordination, task ownership, project health, and AI issue separation.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => openNewIssue({ workItemType: "initiative" })}
            >
              <Target className="h-4 w-4" />
              New initiative
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => openNewIssue({ workItemType: "human_task" })}
            >
              <Plus className="h-4 w-4" />
              New task
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {(Object.entries(FILTER_CONFIG) as [WorkItemFilter, WorkHubFilterConfig][]).map(([key, config]) => (
            <LaneButton
              key={key}
              config={config}
              count={dashboard.laneCounts[key]}
              isActive={activeFilter === key}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (key === "all") {
                  next.delete("filter");
                } else {
                  next.set("filter", key);
                }
                setSearchParams(next);
              }}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="space-y-4 px-4 py-4 lg:px-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricTile
              icon={ListChecks}
              label="Open Tasks"
              value={dashboard.openHumanTaskCount}
              detail={`${dashboard.planningPoints} planning pts across owners`}
              tone="blue"
            />
            <MetricTile
              icon={Target}
              label="Initiatives"
              value={dashboard.initiativeCount}
              detail={`${dashboard.completionPct}% task completion`}
              tone="violet"
            />
            <MetricTile
              icon={AlertCircle}
              label="Blocked"
              value={dashboard.blockedCount}
              detail={`${dashboard.unassignedCount} unassigned human tasks`}
              tone={dashboard.blockedCount > 0 ? "red" : "neutral"}
            />
            <MetricTile
              icon={CalendarClock}
              label="Due Soon"
              value={dashboard.dueSoonCount + dashboard.overdueCount}
              detail={`${dashboard.overdueCount} overdue, ${dashboard.dueSoonCount} due this week`}
              tone={dashboard.overdueCount > 0 ? "amber" : "green"}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1fr]">
            <WorkloadPanel rows={dashboard.workload} />
            <ProjectPulsePanel rows={dashboard.projectPulse} />
            <TimelinePanel rows={dashboard.timeline} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-md border border-border bg-background p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">Human Tasks</div>
                  <div className="text-xs text-muted-foreground">Owned by people</div>
                </div>
                <Users className="h-4 w-4 text-blue-600 dark:text-blue-300" />
              </div>
              <div className="mt-3 text-2xl font-semibold text-foreground">{dashboard.humanTaskCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {dashboard.openHumanTaskCount} open / {dashboard.planningPoints} planning pts
              </div>
            </div>
            <div className="rounded-md border border-border bg-background p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">Initiatives</div>
                  <div className="text-xs text-muted-foreground">Project-level outcomes</div>
                </div>
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
              </div>
              <div className="mt-3 text-2xl font-semibold text-foreground">{dashboard.initiativeCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">{dashboard.completionPct}% human-task completion</div>
            </div>
            <div className="rounded-md border border-border bg-background p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-foreground">AI Issues</div>
                  <div className="text-xs text-muted-foreground">Execution lane</div>
                </div>
                <Bot className="h-4 w-4 text-violet-600 dark:text-violet-300" />
              </div>
              <div className="mt-3 text-2xl font-semibold text-foreground">{dashboard.executionIssueCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">Tracked outside human capacity</div>
            </div>
          </div>

          <section className="rounded-md border border-border bg-background p-4 shadow-sm">
            <div className="mb-4 flex flex-col gap-2 border-b border-border pb-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">{filterConfig.label}</h2>
                <p className="text-sm text-muted-foreground">
                  {activeFilter === "execution"
                    ? "Agent-owned issues stay visible without mixing into the human task load."
                    : "Human task planning stays separate from the AI execution lane."}
                </p>
              </div>
              <div className="text-xs tabular-nums text-muted-foreground">
                Showing {issues.length} loaded items
              </div>
            </div>
            <IssuesList
              issues={issues}
              isLoading={isLoading}
              isLoadingMoreIssues={isFetchingNextPage}
              error={error as Error | null}
              agents={agents}
              projects={projects}
              liveIssueIds={liveIssueIds}
              viewStateKey={`paperclip:workhub-view:${activeFilter}`}
              issueLinkState={issueLinkState}
              searchFilters={{ workItemType: workItemTypeParam, excludeRoutineExecutions: true }}
              baseCreateIssueDefaults={{ workItemType: createWorkItemType }}
              createIssueLabel={createIssueLabel}
              defaultIssueColumns={WORK_HUB_DEFAULT_COLUMNS}
              hasMoreIssues={hasMore}
              onLoadMoreIssues={loadMoreIssues}
              onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
