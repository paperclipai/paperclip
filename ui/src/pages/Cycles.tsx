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
import { CalendarClock, Clock, ListChecks, Plus, RefreshCw, Target } from "lucide-react";
import type { Issue, IssuePriority, IssueStatus, Project, WorkCycle } from "@paperclipai/shared";

const CYCLE_PAGE_SIZE = 500;
const OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const PRIORITY_POINTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

type CycleSelection = "all" | "unassigned" | string;

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

function CycleCard({
  summary,
  selected,
  onSelect,
}: {
  summary: CycleSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "rounded-md border bg-background p-4 text-left shadow-sm transition-colors hover:border-ring/60 hover:bg-accent/30",
        selected ? "border-ring ring-1 ring-ring/40" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{summary.label}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{summary.projectLabel} · {summary.dateLabel}</p>
        </div>
        <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2 text-sm">
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{summary.issues.length}</div>
          <div className="text-xs text-muted-foreground">issues</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{summary.storyPoints}</div>
          <div className="text-xs text-muted-foreground">pts</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{summary.estimateHours}</div>
          <div className="text-xs text-muted-foreground">est h</div>
        </div>
        <div>
          <div className="text-2xl font-semibold tabular-nums text-foreground">{formatActualAiTime(summary.actualAiSeconds)}</div>
          <div className="text-xs text-muted-foreground">AI time</div>
        </div>
      </div>
    </button>
  );
}

export function Cycles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedCycleId, setSelectedCycleId] = useState<CycleSelection>("all");
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
  const selectedSummary = selectedCycleId === "all"
    ? null
    : summaries.find((summary) => summary.id === selectedCycleId) ?? null;
  const visibleIssues = selectedCycleId === "all"
    ? issues.filter(isOpenIssue)
    : selectedSummary?.issues ?? [];

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
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
              <button
                type="button"
                onClick={() => setSelectedCycleId("all")}
                className={cn(
                  "rounded-md border bg-background p-4 text-left shadow-sm transition-colors hover:border-ring/60 hover:bg-accent/30",
                  selectedCycleId === "all" ? "border-ring ring-1 ring-ring/40" : "border-border",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">All Open Issues</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">Across visible cycles</p>
                  </div>
                  <ListChecks className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="mt-4 text-2xl font-semibold tabular-nums text-foreground">{issues.filter(isOpenIssue).length}</div>
                <div className="text-xs text-muted-foreground">open issues</div>
              </button>
              {summaries.map((summary) => (
                <CycleCard
                  key={summary.id}
                  summary={summary}
                  selected={selectedCycleId === summary.id}
                  onSelect={() => setSelectedCycleId(summary.id)}
                />
              ))}
            </div>

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
