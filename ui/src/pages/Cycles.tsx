import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { cn, projectUrl } from "../lib/utils";
import { CalendarClock, Clock, Flag, RefreshCw, Target } from "lucide-react";
import type { Issue, IssuePriority, IssueStatus, Project } from "@paperclipai/shared";

const CYCLE_PAGE_SIZE = 500;
const CYCLE_LENGTH_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const PRIORITY_POINTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

type CycleBucketKey = "current" | "next" | "later" | "unscheduled";

type CycleBucket = {
  key: CycleBucketKey;
  label: string;
  dateLabel: string;
  issues: Issue[];
};

type ProjectCycleRow = {
  id: string;
  name: string;
  href: string | null;
  color: string | null;
  cycleCounts: Record<CycleBucketKey, number>;
  open: number;
  blocked: number;
  storyPoints: number;
  estimateHours: number;
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const next = startOfDay(date);
  const day = next.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + mondayOffset);
  return next;
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function formatDateRange(start: Date, end: Date) {
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function pointsForIssue(issue: Issue) {
  if (typeof issue.storyPoints === "number" && Number.isFinite(issue.storyPoints) && issue.storyPoints > 0) {
    return issue.storyPoints;
  }
  return PRIORITY_POINTS[issue.priority] ?? 1;
}

function hoursForIssue(issue: Issue) {
  if (typeof issue.estimateHours !== "number" || !Number.isFinite(issue.estimateHours)) return 0;
  return Math.max(0, issue.estimateHours);
}

function isOpenIssue(issue: Issue) {
  return OPEN_STATUSES.has(issue.status);
}

function buildCycleBuckets(issues: Issue[]): CycleBucket[] {
  const currentStart = startOfWeek(new Date());
  const currentEnd = addDays(currentStart, CYCLE_LENGTH_DAYS - 1);
  const nextStart = addDays(currentEnd, 1);
  const nextEnd = addDays(nextStart, CYCLE_LENGTH_DAYS - 1);

  const buckets: CycleBucket[] = [
    { key: "current", label: "Current Cycle", dateLabel: formatDateRange(currentStart, currentEnd), issues: [] },
    { key: "next", label: "Next Cycle", dateLabel: formatDateRange(nextStart, nextEnd), issues: [] },
    { key: "later", label: "Later", dateLabel: "Future dated", issues: [] },
    { key: "unscheduled", label: "Unscheduled", dateLabel: "No due date", issues: [] },
  ];
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  for (const issue of issues) {
    if (!isOpenIssue(issue)) continue;
    if (!issue.dueDate) {
      byKey.get("unscheduled")?.issues.push(issue);
      continue;
    }
    const due = startOfDay(new Date(issue.dueDate));
    if (due <= currentEnd) byKey.get("current")?.issues.push(issue);
    else if (due <= nextEnd) byKey.get("next")?.issues.push(issue);
    else byKey.get("later")?.issues.push(issue);
  }

  return buckets;
}

function buildProjectRows(issues: Issue[], projects: Project[] | undefined): ProjectCycleRow[] {
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]));
  const currentStart = startOfWeek(new Date());
  const currentEnd = addDays(currentStart, CYCLE_LENGTH_DAYS - 1);
  const nextEnd = addDays(currentEnd, CYCLE_LENGTH_DAYS);
  const rows = new Map<string, ProjectCycleRow>();

  for (const issue of issues) {
    if (!isOpenIssue(issue)) continue;
    const project = issue.projectId ? projectById.get(issue.projectId) ?? issue.project ?? null : null;
    const id = issue.projectId ?? "__no_project";
    const row = rows.get(id) ?? {
      id,
      name: project?.name ?? issue.project?.name ?? "No project",
      href: project ? projectUrl(project) : null,
      color: project?.color ?? issue.project?.color ?? null,
      cycleCounts: { current: 0, next: 0, later: 0, unscheduled: 0 },
      open: 0,
      blocked: 0,
      storyPoints: 0,
      estimateHours: 0,
    };

    const due = issue.dueDate ? startOfDay(new Date(issue.dueDate)) : null;
    const bucketKey: CycleBucketKey = !due
      ? "unscheduled"
      : due <= currentEnd
        ? "current"
        : due <= nextEnd
          ? "next"
          : "later";
    row.cycleCounts[bucketKey] += 1;
    row.open += 1;
    if (issue.status === "blocked") row.blocked += 1;
    if (issue.workItemType === "human_task") {
      row.storyPoints += pointsForIssue(issue);
      row.estimateHours += hoursForIssue(issue);
    }
    rows.set(id, row);
  }

  return [...rows.values()]
    .sort((a, b) => b.cycleCounts.current - a.cycleCounts.current || b.storyPoints - a.storyPoints || a.name.localeCompare(b.name))
    .slice(0, 12);
}

function CycleMetricCard({ bucket }: { bucket: CycleBucket }) {
  const storyPoints = bucket.issues.reduce((total, issue) => issue.workItemType === "human_task" ? total + pointsForIssue(issue) : total, 0);
  const estimateHours = bucket.issues.reduce((total, issue) => issue.workItemType === "human_task" ? total + hoursForIssue(issue) : total, 0);
  const blocked = bucket.issues.filter((issue) => issue.status === "blocked").length;

  return (
    <section className="rounded-md border border-border bg-background p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{bucket.label}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{bucket.dateLabel}</p>
        </div>
        <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{bucket.issues.length}</div>
          <div className="text-xs text-muted-foreground">items</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{storyPoints}</div>
          <div className="text-xs text-muted-foreground">pts</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{estimateHours}</div>
          <div className="text-xs text-muted-foreground">hours</div>
        </div>
      </div>
      {blocked > 0 ? <div className="mt-3 text-xs font-medium text-rose-600 dark:text-rose-400">{blocked} blocked</div> : null}
    </section>
  );
}

export function Cycles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Cycles" }]);
  }, [setBreadcrumbs]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: issues = [], isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "cycles",
      CYCLE_PAGE_SIZE,
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      excludeRoutineExecutions: true,
      workItemType: "human_task,initiative",
      limit: CYCLE_PAGE_SIZE,
    }),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const cycleBuckets = useMemo(() => buildCycleBuckets(issues), [issues]);
  const projectRows = useMemo(() => buildProjectRows(issues, projects), [issues, projects]);

  if (!selectedCompanyId) {
    return <EmptyState icon={RefreshCw} message="Select a company to view cycles." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
          <h1 className="truncate text-lg font-semibold text-foreground">Cycles</h1>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">Human work by cycle, project, Story Points, and Estimate Hours.</p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 lg:px-6">
        {error ? (
          <EmptyState icon={RefreshCw} message={error instanceof Error ? error.message : "Unable to load cycles."} />
        ) : isLoading ? (
          <div className="text-sm text-muted-foreground">Loading cycles...</div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
              {cycleBuckets.map((bucket) => <CycleMetricCard key={bucket.key} bucket={bucket} />)}
            </div>

            <section className="rounded-md border border-border bg-background p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Project Cycle Load</h2>
                  <p className="text-sm text-muted-foreground">Open human tasks and initiatives grouped by project.</p>
                </div>
                <Flag className="h-4 w-4 text-muted-foreground" />
              </div>

              {projectRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                  No open cycle work yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border text-left">
                        <th className="py-2 pr-3 font-medium">Project</th>
                        <th className="px-3 py-2 font-medium">Current</th>
                        <th className="px-3 py-2 font-medium">Next</th>
                        <th className="px-3 py-2 font-medium">Later</th>
                        <th className="px-3 py-2 font-medium">Unscheduled</th>
                        <th className="px-3 py-2 font-medium">Story Points</th>
                        <th className="px-3 py-2 font-medium">Estimate</th>
                        <th className="px-3 py-2 font-medium">Blocked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {projectRows.map((row) => {
                        const projectCell = (
                          <span className="inline-flex min-w-0 items-center gap-2">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: row.color ?? "currentColor" }}
                            />
                            <span className="truncate font-medium text-foreground">{row.name}</span>
                          </span>
                        );
                        return (
                          <tr key={row.id} className="hover:bg-muted/40">
                            <td className="max-w-[260px] py-3 pr-3">
                              {row.href ? <Link to={row.href} className="block min-w-0">{projectCell}</Link> : projectCell}
                            </td>
                            {(["current", "next", "later", "unscheduled"] as const).map((key) => (
                              <td key={key} className="px-3 py-3 tabular-nums text-muted-foreground">
                                {row.cycleCounts[key]}
                              </td>
                            ))}
                            <td className="px-3 py-3 tabular-nums text-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                                {row.storyPoints}
                              </span>
                            </td>
                            <td className="px-3 py-3 tabular-nums text-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                {row.estimateHours}h
                              </span>
                            </td>
                            <td className={cn("px-3 py-3 tabular-nums", row.blocked > 0 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                              {row.blocked}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {issues.length >= CYCLE_PAGE_SIZE ? (
              <div className="text-xs text-muted-foreground">
                Showing first {CYCLE_PAGE_SIZE} loaded human-work items.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
