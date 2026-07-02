import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { workCyclesApi } from "../api/work-cycles";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { cn, projectUrl } from "../lib/utils";
import { CalendarClock, Clock, Plus, RefreshCw, Search, Target } from "lucide-react";
import type { Issue, IssuePriority, IssueStatus, Project, WorkCycle } from "@paperclipai/shared";

const CYCLE_PAGE_SIZE = 500;
const OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const CYCLE_STATUS_FILTERS: Array<{ value: CycleStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];
const PRIORITY_POINTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

type CycleSelection = "all" | "unassigned" | string;
type CycleStatusFilter = "all" | WorkCycle["status"];

type CycleSummary = {
  id: CycleSelection;
  cycle: WorkCycle | null;
  label: string;
  dateLabel: string;
  projectLabel: string;
  issues: Issue[];
  storyPoints: number;
  estimateHours: number;
  actualAiSeconds: number;
};

function isOpenIssue(issue: Issue) {
  return OPEN_STATUSES.has(issue.status);
}

function pointsForIssue(issue: Issue) {
  if (typeof issue.storyPoints === "number" && Number.isFinite(issue.storyPoints) && issue.storyPoints > 0) {
    return issue.storyPoints;
  }
  return PRIORITY_POINTS[issue.priority] ?? 1;
}

function estimateHoursForIssue(issue: Issue) {
  if (typeof issue.estimateHours !== "number" || !Number.isFinite(issue.estimateHours)) return 0;
  return Math.max(0, issue.estimateHours);
}

function actualAiSecondsForIssue(issue: Issue) {
  if (typeof issue.actualAiSeconds !== "number" || !Number.isFinite(issue.actualAiSeconds)) return 0;
  return Math.max(0, issue.actualAiSeconds);
}

function formatDateRange(cycle: WorkCycle | null) {
  if (!cycle) return "No assigned cycle";
  if (cycle.startDate && cycle.endDate) return `${new Date(cycle.startDate).toLocaleDateString()} - ${new Date(cycle.endDate).toLocaleDateString()}`;
  if (cycle.startDate) return `Starts ${new Date(cycle.startDate).toLocaleDateString()}`;
  if (cycle.endDate) return `Ends ${new Date(cycle.endDate).toLocaleDateString()}`;
  return cycle.status;
}

function formatActualAiTime(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds <= 0) return "0m";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours <= 0) return `${Math.max(1, minutes)}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function statusLabel(status: WorkCycle["status"]) {
  return status.replace(/_/g, " ");
}

function statusClassName(status: WorkCycle["status"]) {
  switch (status) {
    case "active":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
    case "planned":
      return "border-blue-500/30 bg-blue-500/10 text-blue-500";
    case "completed":
      return "border-muted-foreground/20 bg-muted text-muted-foreground";
    case "archived":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function projectName(projects: Project[] | undefined, projectId: string | null | undefined) {
  if (!projectId) return "Company-wide";
  return projects?.find((project) => project.id === projectId)?.name ?? "Project";
}

function buildCycleSummaries(
  cycles: WorkCycle[],
  issues: Issue[],
  projects: Project[] | undefined,
): CycleSummary[] {
  const openIssues = issues.filter(isOpenIssue);
  const summaries: CycleSummary[] = cycles.map((cycle) => {
    const cycleIssues = openIssues.filter((issue) => issue.cycleId === cycle.id);
    return {
      id: cycle.id,
      cycle,
      label: cycle.name,
      dateLabel: formatDateRange(cycle),
      projectLabel: projectName(projects, cycle.projectId),
      issues: cycleIssues,
      storyPoints: cycleIssues.reduce((total, issue) => total + pointsForIssue(issue), 0),
      estimateHours: cycleIssues.reduce((total, issue) => total + estimateHoursForIssue(issue), 0),
      actualAiSeconds: cycleIssues.reduce((total, issue) => total + actualAiSecondsForIssue(issue), 0),
    };
  });
  const unassignedIssues = openIssues.filter((issue) => !issue.cycleId);
  summaries.push({
    id: "unassigned",
    cycle: null,
    label: "Unassigned",
    dateLabel: "No cycle selected",
    projectLabel: "Needs planning",
    issues: unassignedIssues,
    storyPoints: unassignedIssues.reduce((total, issue) => total + pointsForIssue(issue), 0),
    estimateHours: unassignedIssues.reduce((total, issue) => total + estimateHoursForIssue(issue), 0),
    actualAiSeconds: unassignedIssues.reduce((total, issue) => total + actualAiSecondsForIssue(issue), 0),
  });
  return summaries.sort((a, b) => {
    if (a.id === "unassigned") return 1;
    if (b.id === "unassigned") return -1;
    const statusOrder = (cycle: WorkCycle | null) => cycle?.status === "active" ? 0 : cycle?.status === "planned" ? 1 : 2;
    return statusOrder(a.cycle) - statusOrder(b.cycle)
      || (a.cycle?.startDate ?? "").localeCompare(b.cycle?.startDate ?? "")
      || a.label.localeCompare(b.label);
  });
}

export function Cycles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedCycleId, setSelectedCycleId] = useState<CycleSelection>("all");
  const [cycleSearch, setCycleSearch] = useState("");
  const [cycleStatusFilter, setCycleStatusFilter] = useState<CycleStatusFilter>("all");
  const [newCycleName, setNewCycleName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Cycles" }]);
  }, [setBreadcrumbs]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: cycles = [], isLoading: cyclesLoading, error: cyclesError } = useQuery({
    queryKey: queryKeys.workCycles.list(selectedCompanyId!, projectFilter === "all" ? null : projectFilter),
    queryFn: () => workCyclesApi.list(selectedCompanyId!, {
      projectId: projectFilter === "all" ? null : projectFilter,
      includeCompanyWide: true,
    }),
    enabled: !!selectedCompanyId,
  });

  const { data: issues = [], isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "cycles",
      projectFilter,
      CYCLE_PAGE_SIZE,
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      excludeRoutineExecutions: true,
      projectId: projectFilter === "all" ? undefined : projectFilter,
      limit: CYCLE_PAGE_SIZE,
    }),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const createCycle = useMutation({
    mutationFn: (name: string) => workCyclesApi.create(selectedCompanyId!, {
      name,
      projectId: projectFilter === "all" ? null : projectFilter,
      status: "planned",
    }),
    onSuccess: async (cycle) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workCycles.list(selectedCompanyId!, projectFilter === "all" ? null : projectFilter) });
      setSelectedCycleId(cycle.id);
      setNewCycleName("");
    },
  });

  const summaries = useMemo(() => buildCycleSummaries(cycles, issues, projects), [cycles, issues, projects]);
  const openIssues = useMemo(() => issues.filter(isOpenIssue), [issues]);
  const filteredSummaries = useMemo(() => {
    const normalizedQuery = cycleSearch.trim().toLowerCase();
    return summaries.filter((summary) => {
      if (summary.id === "unassigned" && cycleStatusFilter !== "all") return false;
      if (summary.cycle && cycleStatusFilter !== "all" && summary.cycle.status !== cycleStatusFilter) return false;
      if (!normalizedQuery) return true;
      return [
        summary.label,
        summary.projectLabel,
        summary.dateLabel,
        summary.cycle?.status ?? "unassigned",
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [cycleSearch, cycleStatusFilter, summaries]);
  const totals = useMemo(() => ({
    cycles: cycles.length,
    activeCycles: cycles.filter((cycle) => cycle.status === "active").length,
    issues: openIssues.length,
    storyPoints: openIssues.reduce((total, issue) => total + pointsForIssue(issue), 0),
    estimateHours: openIssues.reduce((total, issue) => total + estimateHoursForIssue(issue), 0),
    actualAiSeconds: openIssues.reduce((total, issue) => total + actualAiSecondsForIssue(issue), 0),
  }), [cycles, openIssues]);
  const selectedSummary = selectedCycleId === "all"
    ? null
    : summaries.find((summary) => summary.id === selectedCycleId) ?? null;
  const visibleIssues = selectedCycleId === "all"
    ? openIssues
    : selectedSummary?.issues ?? [];
  const detailMetrics = selectedSummary ?? {
    storyPoints: totals.storyPoints,
    estimateHours: totals.estimateHours,
    actualAiSeconds: totals.actualAiSeconds,
    issues: openIssues,
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={RefreshCw} message="Select a company to view cycles." />;
  }

  const loading = cyclesLoading || issuesLoading;
  const error = cyclesError ?? issuesError;

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <h1 className="truncate text-lg font-semibold text-foreground">Cycles</h1>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">Plan issues into project cycles with points, estimates, and actual AI time.</p>
          </div>
          <form
            className="flex min-w-0 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const name = newCycleName.trim();
              if (!name || createCycle.isPending) return;
              createCycle.mutate(name);
            }}
          >
            <select
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
              value={projectFilter}
              onChange={(event) => {
                setProjectFilter(event.target.value);
                setSelectedCycleId("all");
                setCycleSearch("");
              }}
            >
              <option value="all">All projects</option>
              {(projects ?? []).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <input
              className="h-8 w-44 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
              value={newCycleName}
              onChange={(event) => setNewCycleName(event.target.value)}
              placeholder="New cycle"
            />
            <button
              type="submit"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
              disabled={!newCycleName.trim() || createCycle.isPending}
            >
              <Plus className="h-3.5 w-3.5" />
              Cycle
            </button>
          </form>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 lg:px-6">
        {error ? (
          <EmptyState icon={RefreshCw} message={error instanceof Error ? error.message : "Unable to load cycles."} />
        ) : loading ? (
          <div className="text-sm text-muted-foreground">Loading cycles...</div>
        ) : (
          <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(440px,520px)_minmax(0,1fr)]">
            <section className="flex min-h-[420px] flex-col rounded-md border border-border bg-background shadow-sm">
              <div className="border-b border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-foreground">Cycle Index</h2>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {filteredSummaries.length} shown · {cycles.length} cycles total
                    </p>
                  </div>
                  <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px]">
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                      value={cycleSearch}
                      onChange={(event) => setCycleSearch(event.target.value)}
                      placeholder="Search cycles..."
                    />
                  </label>
                  <select
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                    value={cycleStatusFilter}
                    onChange={(event) => setCycleStatusFilter(event.target.value as CycleStatusFilter)}
                  >
                    {CYCLE_STATUS_FILTERS.map((filter) => (
                      <option key={filter.value} value={filter.value}>{filter.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-4 border-b border-border text-xs">
                <div className="border-r border-border px-3 py-2">
                  <div className="font-semibold tabular-nums text-foreground">{totals.activeCycles}</div>
                  <div className="text-muted-foreground">active</div>
                </div>
                <div className="border-r border-border px-3 py-2">
                  <div className="font-semibold tabular-nums text-foreground">{totals.issues}</div>
                  <div className="text-muted-foreground">issues</div>
                </div>
                <div className="border-r border-border px-3 py-2">
                  <div className="font-semibold tabular-nums text-foreground">{totals.storyPoints}</div>
                  <div className="text-muted-foreground">points</div>
                </div>
                <div className="px-3 py-2">
                  <div className="font-semibold tabular-nums text-foreground">{totals.estimateHours}h</div>
                  <div className="text-muted-foreground">estimate</div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="sticky top-0 z-10 border-b border-border bg-background text-xs uppercase text-muted-foreground">
                    <tr className="text-left">
                      <th className="py-2 pl-3 pr-2 font-medium">Cycle</th>
                      <th className="px-2 py-2 font-medium">Work</th>
                      <th className="px-2 py-2 font-medium">Estimate</th>
                      <th className="py-2 pl-2 pr-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    <tr className={cn("hover:bg-muted/40", selectedCycleId === "all" && "bg-accent/40")}>
                      <td className="py-2 pl-3 pr-2">
                        <button
                          type="button"
                          onClick={() => setSelectedCycleId("all")}
                          className="block w-full min-w-0 text-left"
                          aria-pressed={selectedCycleId === "all"}
                        >
                          <span className="block truncate font-medium text-foreground">All Open Issues</span>
                          <span className="block truncate text-xs text-muted-foreground">Across visible cycles</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{totals.issues} issues · {totals.storyPoints} pts</td>
                      <td className="px-2 py-2 tabular-nums text-muted-foreground">{totals.estimateHours}h · {formatActualAiTime(totals.actualAiSeconds)}</td>
                      <td className="py-2 pl-2 pr-3">
                        <span className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">rollup</span>
                      </td>
                    </tr>
                    {filteredSummaries.map((summary) => (
                      <tr
                        key={summary.id}
                        className={cn("hover:bg-muted/40", selectedCycleId === summary.id && "bg-accent/40")}
                      >
                        <td className="py-2 pl-3 pr-2">
                          <button
                            type="button"
                            onClick={() => setSelectedCycleId(summary.id)}
                            className="block w-full min-w-0 text-left"
                            aria-pressed={selectedCycleId === summary.id}
                          >
                            <span className="block truncate font-medium text-foreground">{summary.label}</span>
                            <span className="block truncate text-xs text-muted-foreground">{summary.projectLabel} · {summary.dateLabel}</span>
                          </button>
                        </td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{summary.issues.length} issues · {summary.storyPoints} pts</td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{summary.estimateHours}h · {formatActualAiTime(summary.actualAiSeconds)}</td>
                        <td className="py-2 pl-2 pr-3">
                          {summary.cycle ? (
                            <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs capitalize", statusClassName(summary.cycle.status))}>
                              {statusLabel(summary.cycle.status)}
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">unassigned</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-md border border-border bg-background p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {selectedCycleId === "all" ? "Cycle Issues" : selectedSummary?.label ?? "Cycle Issues"}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {visibleIssues.length} open issues · assign or change cycles from each issue properties panel.
                  </p>
                </div>
                <CalendarClock className="h-4 w-4 text-muted-foreground" />
              </div>

              <div className="mb-3 grid grid-cols-4 gap-2 rounded-md border border-border bg-muted/20 p-2 text-sm">
                <div className="px-2 py-1">
                  <div className="text-xs text-muted-foreground">Open issues</div>
                  <div className="font-semibold tabular-nums text-foreground">{detailMetrics.issues.length}</div>
                </div>
                <div className="px-2 py-1">
                  <div className="text-xs text-muted-foreground">Story points</div>
                  <div className="font-semibold tabular-nums text-foreground">{detailMetrics.storyPoints}</div>
                </div>
                <div className="px-2 py-1">
                  <div className="text-xs text-muted-foreground">Estimate</div>
                  <div className="font-semibold tabular-nums text-foreground">{detailMetrics.estimateHours}h</div>
                </div>
                <div className="px-2 py-1">
                  <div className="text-xs text-muted-foreground">AI time</div>
                  <div className="font-semibold tabular-nums text-foreground">{formatActualAiTime(detailMetrics.actualAiSeconds)}</div>
                </div>
              </div>

              {visibleIssues.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                  No open issues in this cycle view.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead className="text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border text-left">
                        <th className="py-2 pr-3 font-medium">Issue</th>
                        <th className="px-3 py-2 font-medium">Project</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Priority</th>
                        <th className="px-3 py-2 font-medium">Story Points</th>
                        <th className="px-3 py-2 font-medium">Estimate</th>
                        <th className="px-3 py-2 font-medium">AI Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {visibleIssues.map((issue) => {
                        const project = issue.projectId ? projects?.find((item) => item.id === issue.projectId) : null;
                        return (
                          <tr key={issue.id} className="hover:bg-muted/40">
                            <td className="max-w-[360px] py-3 pr-3">
                              <Link to={`/issues/${issue.identifier ?? issue.id}`} className="block min-w-0">
                                <span className="mr-2 font-mono text-xs text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)}</span>
                                <span className="font-medium text-foreground">{issue.title}</span>
                              </Link>
                            </td>
                            <td className="px-3 py-3">
                              {project ? (
                                <Link to={projectUrl(project)} className="inline-flex min-w-0 items-center gap-2">
                                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project.color ?? "currentColor" }} />
                                  <span className="truncate text-muted-foreground">{project.name}</span>
                                </Link>
                              ) : (
                                <span className="text-muted-foreground">No project</span>
                              )}
                            </td>
                            <td className="px-3 py-3 text-muted-foreground">{issue.status.replace(/_/g, " ")}</td>
                            <td className="px-3 py-3 text-muted-foreground">{issue.priority}</td>
                            <td className="px-3 py-3 tabular-nums text-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Target className="h-3.5 w-3.5 text-muted-foreground" />
                                {pointsForIssue(issue)}
                              </span>
                            </td>
                            <td className="px-3 py-3 tabular-nums text-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                                {estimateHoursForIssue(issue)}h
                              </span>
                            </td>
                            <td className="px-3 py-3 tabular-nums text-foreground">{formatActualAiTime(actualAiSecondsForIssue(issue))}</td>
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
                Showing first {CYCLE_PAGE_SIZE} loaded issues.
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
