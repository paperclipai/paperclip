import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { workCyclesApi } from "../api/work-cycles";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { cn, projectUrl } from "../lib/utils";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  ChevronsRight,
  Clock,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Search,
  Target,
  TrendingUp,
} from "lucide-react";
import type {
  CreateWorkCycle,
  Issue,
  IssuePriority,
  IssueStatus,
  Project,
  UpdateWorkCycle,
  WorkCycle,
} from "@paperclipai/shared";

const CYCLE_PAGE_SIZE = 1000;
const OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const DONE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const PRIORITY_POINTS: Record<IssuePriority, number> = {
  critical: 8,
  high: 5,
  medium: 3,
  low: 1,
};

const CYCLE_STATUS_FILTERS: Array<{ value: CycleStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "planned", label: "Upcoming" },
  { value: "completed", label: "Completed" },
  { value: "unassigned", label: "Backlog" },
  { value: "archived", label: "Archived" },
];

type CycleSelection = "all" | "unassigned" | string;
type CycleStatusFilter = "all" | "unassigned" | WorkCycle["status"];

type NewCycleForm = {
  name: string;
  startDate: string;
  endDate: string;
  capacityStoryPoints: string;
  capacityHours: string;
};

type CycleSummary = {
  id: CycleSelection;
  cycle: WorkCycle | null;
  label: string;
  dateLabel: string;
  projectLabel: string;
  issues: Issue[];
  openIssues: Issue[];
  completedIssues: Issue[];
  issueCount: number;
  openCount: number;
  completedCount: number;
  storyPoints: number;
  openStoryPoints: number;
  completedStoryPoints: number;
  estimateHours: number;
  openEstimateHours: number;
  actualAiSeconds: number;
  progressPercent: number;
  capacityStoryPoints: number | null;
  capacityHours: number | null;
};

function emptyNewCycleForm(): NewCycleForm {
  return {
    name: "",
    startDate: "",
    endDate: "",
    capacityStoryPoints: "",
    capacityHours: "",
  };
}

function isOpenIssue(issue: Issue) {
  return OPEN_STATUSES.has(issue.status);
}

function isCompletedIssue(issue: Issue) {
  return DONE_STATUSES.has(issue.status);
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

function formatShortDate(value: string | Date | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateRange(cycle: WorkCycle | null) {
  if (!cycle) return "No assigned cycle";
  if (cycle.startDate && cycle.endDate) return `${formatShortDate(cycle.startDate)} - ${formatShortDate(cycle.endDate)}`;
  if (cycle.startDate) return `Starts ${formatShortDate(cycle.startDate)}`;
  if (cycle.endDate) return `Ends ${formatShortDate(cycle.endDate)}`;
  return cycle.status === "planned" ? "Not scheduled" : statusLabel(cycle.status);
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
  if (status === "planned") return "upcoming";
  return status.replace(/_/g, " ");
}

function issueStatusLabel(status: IssueStatus) {
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

function issueStatusClassName(status: IssueStatus) {
  if (status === "done") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-500";
  if (status === "cancelled") return "border-muted-foreground/20 bg-muted text-muted-foreground";
  if (status === "blocked") return "border-destructive/30 bg-destructive/10 text-destructive";
  if (status === "in_progress" || status === "in_review") return "border-amber-500/30 bg-amber-500/10 text-amber-500";
  return "border-border bg-muted text-muted-foreground";
}

function projectName(projects: Project[] | undefined, projectId: string | null | undefined) {
  if (!projectId) return "Company-wide";
  return projects?.find((project) => project.id === projectId)?.name ?? "Project";
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseOptionalIntegerInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function todayDateInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function dateInputValue(value: string | Date | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function cycleScopeKey(cycle: WorkCycle) {
  return cycle.projectId ?? "__company__";
}

function isCycleCompatibleWithIssue(cycle: WorkCycle, issue: Issue) {
  return !cycle.projectId || cycle.projectId === issue.projectId;
}

function isAssignableCycleForIssue(cycle: WorkCycle, issue: Issue) {
  return cycle.status !== "archived" && cycle.status !== "completed" && isCycleCompatibleWithIssue(cycle, issue);
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sumIssues(issues: Issue[], getValue: (issue: Issue) => number) {
  return issues.reduce((total, issue) => total + getValue(issue), 0);
}

function sortIssuesForCycle(issues: Issue[]) {
  const statusOrder = (issue: Issue) => isOpenIssue(issue) ? 0 : isCompletedIssue(issue) ? 1 : 2;
  const priorityOrder = (issue: Issue) => ({ critical: 0, high: 1, medium: 2, low: 3 }[issue.priority] ?? 4);
  return [...issues].sort((a, b) => {
    const statusDelta = statusOrder(a) - statusOrder(b);
    if (statusDelta !== 0) return statusDelta;
    const priorityDelta = priorityOrder(a) - priorityOrder(b);
    if (priorityDelta !== 0) return priorityDelta;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function summarizeCycle(
  id: CycleSelection,
  cycle: WorkCycle | null,
  label: string,
  dateLabel: string,
  projectLabel: string,
  cycleIssues: Issue[],
): CycleSummary {
  const issues = sortIssuesForCycle(cycleIssues);
  const openIssues = issues.filter(isOpenIssue);
  const completedIssues = issues.filter(isCompletedIssue);
  const storyPoints = sumIssues(issues, pointsForIssue);
  const completedStoryPoints = sumIssues(completedIssues, pointsForIssue);
  const openStoryPoints = sumIssues(openIssues, pointsForIssue);
  const estimateHours = sumIssues(issues, estimateHoursForIssue);
  const openEstimateHours = sumIssues(openIssues, estimateHoursForIssue);
  const progressPercent = issues.length > 0 ? clampPercent((completedIssues.length / issues.length) * 100) : 0;

  return {
    id,
    cycle,
    label,
    dateLabel,
    projectLabel,
    issues,
    openIssues,
    completedIssues,
    issueCount: issues.length,
    openCount: openIssues.length,
    completedCount: completedIssues.length,
    storyPoints,
    openStoryPoints,
    completedStoryPoints,
    estimateHours,
    openEstimateHours,
    actualAiSeconds: sumIssues(issues, actualAiSecondsForIssue),
    progressPercent,
    capacityStoryPoints: cycle?.capacityStoryPoints ?? null,
    capacityHours: cycle?.capacityHours ?? null,
  };
}

function buildCycleSummaries(
  cycles: WorkCycle[],
  issues: Issue[],
  projects: Project[] | undefined,
): CycleSummary[] {
  const summaries = cycles.map((cycle) => summarizeCycle(
    cycle.id,
    cycle,
    cycle.name,
    formatDateRange(cycle),
    projectName(projects, cycle.projectId),
    issues.filter((issue) => issue.cycleId === cycle.id),
  ));

  const unassignedIssues = issues.filter((issue) => !issue.cycleId && isOpenIssue(issue));
  summaries.push(summarizeCycle(
    "unassigned",
    null,
    "Cycle backlog",
    "No cycle selected",
    "Needs planning",
    unassignedIssues,
  ));

  return summaries.sort((a, b) => {
    if (a.id === "unassigned") return 1;
    if (b.id === "unassigned") return -1;
    const statusOrder = (cycle: WorkCycle | null) => {
      if (!cycle) return 4;
      if (cycle.status === "active") return 0;
      if (cycle.status === "planned") return 1;
      if (cycle.status === "completed") return 2;
      return 3;
    };
    const statusDelta = statusOrder(a.cycle) - statusOrder(b.cycle);
    if (statusDelta !== 0) return statusDelta;
    const aDate = a.cycle?.startDate ?? a.cycle?.endDate ?? "";
    const bDate = b.cycle?.startDate ?? b.cycle?.endDate ?? "";
    return aDate.localeCompare(bDate) || a.label.localeCompare(b.label);
  });
}

function buildCreateCyclePayload(form: NewCycleForm, projectFilter: string): CreateWorkCycle {
  return {
    name: form.name.trim(),
    projectId: projectFilter === "all" ? null : projectFilter,
    status: "planned",
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    capacityStoryPoints: parseOptionalIntegerInput(form.capacityStoryPoints),
    capacityHours: parseOptionalIntegerInput(form.capacityHours),
  };
}

function canTransferAllOpenWork(targetCycle: WorkCycle, issues: Issue[]) {
  return issues.length > 0 && issues.every((issue) => isAssignableCycleForIssue(targetCycle, issue));
}

type CycleOverviewPanelProps = {
  summaries: CycleSummary[];
  backlogCount: number;
  onSelectCycle: (cycleId: CycleSelection) => void;
  onOpenBacklog: () => void;
};

const CYCLE_OVERVIEW_LANES: Array<{
  status: Extract<WorkCycle["status"], "active" | "planned" | "completed">;
  label: string;
  empty: string;
}> = [
  { status: "active", label: "Active", empty: "No active cycle." },
  { status: "planned", label: "Upcoming", empty: "No upcoming cycle." },
  { status: "completed", label: "Completed", empty: "No completed cycles yet." },
];

function CycleOverviewCard({
  summary,
  onSelectCycle,
}: {
  summary: CycleSummary & { cycle: WorkCycle };
  onSelectCycle: (cycleId: CycleSelection) => void;
}) {
  return (
    <button
      type="button"
      className="block w-full rounded-md border border-border bg-background p-3 text-left shadow-sm transition-colors hover:border-foreground/30 hover:bg-accent/30"
      onClick={() => onSelectCycle(summary.id)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{summary.label}</span>
            <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] capitalize", statusClassName(summary.cycle.status))}>
              {statusLabel(summary.cycle.status)}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {summary.projectLabel} · {summary.dateLabel}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{summary.progressPercent}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", summary.cycle.status === "completed" ? "bg-muted-foreground" : "bg-emerald-500")}
          style={{ width: `${summary.progressPercent}%` }}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{summary.openCount} open</span>
        <span className="tabular-nums">{summary.openStoryPoints} pts</span>
        <span className="tabular-nums">{summary.openEstimateHours}h</span>
      </div>
    </button>
  );
}

function CycleOverviewPanel({
  summaries,
  backlogCount,
  onSelectCycle,
  onOpenBacklog,
}: CycleOverviewPanelProps) {
  const cycleSummaries = summaries.filter(
    (summary): summary is CycleSummary & { cycle: WorkCycle } =>
      !!summary.cycle && summary.cycle.status !== "archived",
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Backlog planning queue</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {backlogCount} open item{backlogCount === 1 ? "" : "s"} are not assigned to a cycle.
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
          onClick={onOpenBacklog}
          disabled={backlogCount === 0}
        >
          <Archive className="h-3.5 w-3.5" />
          Plan backlog
        </button>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        {CYCLE_OVERVIEW_LANES.map((lane) => {
          const laneSummaries = cycleSummaries.filter((summary) => summary.cycle.status === lane.status);
          return (
            <section key={lane.status} className="min-w-0 rounded-md border border-border bg-muted/10">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="text-sm font-semibold text-foreground">{lane.label}</div>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {laneSummaries.length}
                </span>
              </div>
              <div className="space-y-2 p-2">
                {laneSummaries.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    {lane.empty}
                  </div>
                ) : laneSummaries.map((summary) => (
                  <CycleOverviewCard key={summary.id} summary={summary} onSelectCycle={onSelectCycle} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function Cycles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedCycleId, setSelectedCycleId] = useState<CycleSelection>("all");
  const [cycleSearch, setCycleSearch] = useState("");
  const [cycleStatusFilter, setCycleStatusFilter] = useState<CycleStatusFilter>("all");
  const [newCycle, setNewCycle] = useState<NewCycleForm>(() => emptyNewCycleForm());
  const [transferTargetCycleId, setTransferTargetCycleId] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Cycles" }]);
  }, [setBreadcrumbs]);

  const cycleListQueryKey = useMemo(
    () => queryKeys.workCycles.list(selectedCompanyId!, projectFilter === "all" ? null : projectFilter),
    [projectFilter, selectedCompanyId],
  );

  const invalidateCycleData = useCallback(async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cycleListQueryKey }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) }),
    ]);
  }, [cycleListQueryKey, queryClient, selectedCompanyId]);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: cycles = [], isLoading: cyclesLoading, error: cyclesError } = useQuery({
    queryKey: cycleListQueryKey,
    queryFn: () => workCyclesApi.list(selectedCompanyId!, {
      projectId: projectFilter === "all" ? null : projectFilter,
      includeCompanyWide: true,
      includeArchived: true,
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
    mutationFn: (payload: CreateWorkCycle) => workCyclesApi.create(selectedCompanyId!, payload),
    onSuccess: async (cycle) => {
      await invalidateCycleData();
      setSelectedCycleId(cycle.id);
      setCycleStatusFilter("all");
      setNewCycle(emptyNewCycleForm());
      pushToast({ title: "Cycle created", body: cycle.name, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not create cycle",
        body: getErrorMessage(error, "The cycle could not be created."),
        tone: "error",
      });
    },
  });

  const updateCycle = useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWorkCycle }) => workCyclesApi.update(id, data),
    onSuccess: async (cycle) => {
      await invalidateCycleData();
      pushToast({ title: "Cycle updated", body: cycle.name, tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not update cycle",
        body: getErrorMessage(error, "The cycle could not be updated."),
        tone: "error",
      });
    },
  });

  const updateIssueCycle = useMutation({
    mutationFn: ({ issueId, cycleId }: { issueId: string; cycleId: string | null }) =>
      issuesApi.update(issueId, { cycleId }),
    onSuccess: async () => {
      await invalidateCycleData();
    },
    onError: (error) => {
      pushToast({
        title: "Could not move issue",
        body: getErrorMessage(error, "The issue cycle could not be changed."),
        tone: "error",
      });
    },
  });

  const transferOpenWork = useMutation({
    mutationFn: ({ targetCycleId, issueIds }: { targetCycleId: string; issueIds: string[] }) =>
      Promise.all(issueIds.map((issueId) => issuesApi.update(issueId, { cycleId: targetCycleId }))),
    onSuccess: async (_result, variables) => {
      await invalidateCycleData();
      pushToast({
        title: "Open work transferred",
        body: `${variables.issueIds.length} issue${variables.issueIds.length === 1 ? "" : "s"} moved to the next cycle.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not transfer open work",
        body: getErrorMessage(error, "The open issues could not be transferred."),
        tone: "error",
      });
    },
  });

  const summaries = useMemo(() => buildCycleSummaries(cycles, issues, projects), [cycles, issues, projects]);
  const openIssues = useMemo(() => issues.filter(isOpenIssue), [issues]);
  const cycleAssignedIssues = useMemo(() => issues.filter((issue) => !!issue.cycleId), [issues]);
  const cycleAssignedOpenIssues = useMemo(() => cycleAssignedIssues.filter(isOpenIssue), [cycleAssignedIssues]);
  const cycleAssignedCompletedIssues = useMemo(() => cycleAssignedIssues.filter(isCompletedIssue), [cycleAssignedIssues]);
  const unassignedOpenIssues = useMemo(() => openIssues.filter((issue) => !issue.cycleId), [openIssues]);

  const filterCounts = useMemo(() => ({
    all: cycles.filter((cycle) => cycle.status !== "archived").length,
    active: cycles.filter((cycle) => cycle.status === "active").length,
    planned: cycles.filter((cycle) => cycle.status === "planned").length,
    completed: cycles.filter((cycle) => cycle.status === "completed").length,
    archived: cycles.filter((cycle) => cycle.status === "archived").length,
    unassigned: unassignedOpenIssues.length,
  }), [cycles, unassignedOpenIssues]);

  const filteredSummaries = useMemo(() => {
    const normalizedQuery = cycleSearch.trim().toLowerCase();
    return summaries.filter((summary) => {
      if (cycleStatusFilter === "unassigned") {
        if (summary.id !== "unassigned") return false;
      } else if (summary.id === "unassigned") {
        return false;
      } else if (summary.cycle) {
        if (cycleStatusFilter === "all" && summary.cycle.status === "archived") return false;
        if (cycleStatusFilter !== "all" && summary.cycle.status !== cycleStatusFilter) return false;
      }
      if (!normalizedQuery) return true;
      return [
        summary.label,
        summary.projectLabel,
        summary.dateLabel,
        summary.cycle?.status ?? "unassigned",
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
  }, [cycleSearch, cycleStatusFilter, summaries]);

  const totals = useMemo(() => {
    const storyPoints = sumIssues(cycleAssignedIssues, pointsForIssue);
    const completedStoryPoints = sumIssues(cycleAssignedCompletedIssues, pointsForIssue);
    return {
      cycles: cycles.filter((cycle) => cycle.status !== "archived").length,
      activeCycles: cycles.filter((cycle) => cycle.status === "active").length,
      openIssues: cycleAssignedOpenIssues.length,
      allIssues: cycleAssignedIssues.length,
      storyPoints,
      openStoryPoints: sumIssues(cycleAssignedOpenIssues, pointsForIssue),
      completedStoryPoints,
      estimateHours: sumIssues(cycleAssignedIssues, estimateHoursForIssue),
      openEstimateHours: sumIssues(cycleAssignedOpenIssues, estimateHoursForIssue),
      actualAiSeconds: sumIssues(cycleAssignedIssues, actualAiSecondsForIssue),
      progressPercent: cycleAssignedIssues.length > 0
        ? clampPercent((cycleAssignedCompletedIssues.length / cycleAssignedIssues.length) * 100)
        : 0,
    };
  }, [cycleAssignedCompletedIssues, cycleAssignedIssues, cycleAssignedOpenIssues, cycles]);

  const velocity = useMemo(() => {
    const completedCycles = summaries.filter((summary) => summary.cycle?.status === "completed" && summary.issueCount > 0);
    const totalPoints = completedCycles.reduce((total, summary) => total + summary.completedStoryPoints, 0);
    const totalHours = completedCycles.reduce((total, summary) => total + summary.estimateHours, 0);
    return {
      completedCycleCount: completedCycles.length,
      averagePoints: completedCycles.length > 0 ? Math.round(totalPoints / completedCycles.length) : 0,
      averageHours: completedCycles.length > 0 ? Math.round(totalHours / completedCycles.length) : 0,
    };
  }, [summaries]);

  const selectedSummary = selectedCycleId === "all"
    ? null
    : summaries.find((summary) => summary.id === selectedCycleId) ?? null;
  const selectedCycle = selectedSummary?.cycle ?? null;
  const visibleIssues = selectedSummary ? selectedSummary.issues : [];
  const detailMetrics = selectedSummary ?? {
    issueCount: totals.allIssues,
    openCount: totals.openIssues,
    completedCount: cycleAssignedCompletedIssues.length,
    storyPoints: totals.storyPoints,
    openStoryPoints: totals.openStoryPoints,
    completedStoryPoints: totals.completedStoryPoints,
    estimateHours: totals.estimateHours,
    openEstimateHours: totals.openEstimateHours,
    actualAiSeconds: totals.actualAiSeconds,
    progressPercent: totals.progressPercent,
    capacityStoryPoints: null,
    capacityHours: null,
    issues: cycleAssignedIssues,
    openIssues: cycleAssignedOpenIssues,
    completedIssues: cycleAssignedCompletedIssues,
  };

  const activePeerCycle = useMemo(() => {
    if (!selectedCycle || selectedCycle.status !== "planned") return null;
    return cycles.find((cycle) =>
      cycle.id !== selectedCycle.id &&
      cycle.status === "active" &&
      cycleScopeKey(cycle) === cycleScopeKey(selectedCycle),
    ) ?? null;
  }, [cycles, selectedCycle]);

  const transferTargetCycles = useMemo(() => {
    const openWork = selectedSummary?.openIssues ?? [];
    if (!selectedCycle || openWork.length === 0) return [];
    return cycles.filter((cycle) =>
      cycle.id !== selectedCycle.id &&
      (cycle.status === "planned" || cycle.status === "active") &&
      canTransferAllOpenWork(cycle, openWork),
    );
  }, [cycles, selectedCycle, selectedSummary]);

  useEffect(() => {
    setTransferTargetCycleId(transferTargetCycles[0]?.id ?? "");
  }, [selectedCycleId, transferTargetCycles]);

  useEffect(() => {
    if (selectedCycleId === "all") return;
    if (summaries.some((summary) => summary.id === selectedCycleId)) return;
    setSelectedCycleId("all");
  }, [selectedCycleId, summaries]);

  if (!selectedCompanyId) {
    return <EmptyState icon={RefreshCw} message="Select a company to view cycles." />;
  }

  const loading = cyclesLoading || issuesLoading;
  const error = cyclesError ?? issuesError;
  const newCycleDateInvalid = !!newCycle.startDate && !!newCycle.endDate && newCycle.endDate < newCycle.startDate;
  const selectedProjectLabel = projectFilter === "all" ? "Company-wide" : projectName(projects, projectFilter);
  const transferOpenIssueIds = selectedSummary?.openIssues.map((issue) => issue.id) ?? [];
  const canStartSelectedCycle = !!selectedCycle && selectedCycle.status === "planned" && !activePeerCycle;
  const pointsCapacityPercent = detailMetrics.capacityStoryPoints
    ? clampPercent((detailMetrics.storyPoints / detailMetrics.capacityStoryPoints) * 100)
    : null;
  const hoursCapacityPercent = detailMetrics.capacityHours
    ? clampPercent((detailMetrics.estimateHours / detailMetrics.capacityHours) * 100)
    : null;

  const handleCreateCycle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newCycle.name.trim() || newCycleDateInvalid || createCycle.isPending) return;
    createCycle.mutate(buildCreateCyclePayload(newCycle, projectFilter));
  };

  const handleCycleStatusChange = (cycle: WorkCycle, data: UpdateWorkCycle) => {
    updateCycle.mutate({ id: cycle.id, data });
  };

  const cycleOptionsForIssue = (issue: Issue) => cycles.filter((cycle) =>
    cycle.id === issue.cycleId || isAssignableCycleForIssue(cycle, issue),
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" />
              <h1 className="truncate text-lg font-semibold text-foreground">Cycles</h1>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Timeboxed planning for human and AI issue work, with carry-forward and velocity.
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
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
            <label className="relative block w-56 max-w-full">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                className="h-8 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                value={cycleSearch}
                onChange={(event) => setCycleSearch(event.target.value)}
                placeholder="Search cycles..."
              />
            </label>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 lg:px-6">
        {error ? (
          <EmptyState icon={RefreshCw} message={error instanceof Error ? error.message : "Unable to load cycles."} />
        ) : loading ? (
          <div className="text-sm text-muted-foreground">Loading cycles...</div>
        ) : (
          <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(380px,480px)_minmax(0,1fr)]">
            <section className="flex min-h-[520px] flex-col rounded-md border border-border bg-background shadow-sm">
              <div className="border-b border-border p-3">
                <form className="space-y-2" onSubmit={handleCreateCycle}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">Create cycle</h2>
                      <p className="text-xs text-muted-foreground">Scope: {selectedProjectLabel}</p>
                    </div>
                    <button
                      type="submit"
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
                      disabled={!newCycle.name.trim() || newCycleDateInvalid || createCycle.isPending}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Cycle
                    </button>
                  </div>
                  <input
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                    value={newCycle.name}
                    onChange={(event) => setNewCycle((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Cycle name"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <label className="min-w-0 text-xs text-muted-foreground">
                      Start
                      <input
                        type="date"
                        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                        value={newCycle.startDate}
                        onChange={(event) => setNewCycle((current) => ({ ...current, startDate: event.target.value }))}
                      />
                    </label>
                    <label className="min-w-0 text-xs text-muted-foreground">
                      End
                      <input
                        type="date"
                        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                        value={newCycle.endDate}
                        onChange={(event) => setNewCycle((current) => ({ ...current, endDate: event.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="min-w-0 text-xs text-muted-foreground">
                      Capacity points
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                        value={newCycle.capacityStoryPoints}
                        onChange={(event) => setNewCycle((current) => ({ ...current, capacityStoryPoints: event.target.value }))}
                        placeholder="Optional"
                      />
                    </label>
                    <label className="min-w-0 text-xs text-muted-foreground">
                      Capacity hours
                      <input
                        type="number"
                        min={0}
                        step={1}
                        className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                        value={newCycle.capacityHours}
                        onChange={(event) => setNewCycle((current) => ({ ...current, capacityHours: event.target.value }))}
                        placeholder="Optional"
                      />
                    </label>
                  </div>
                  {newCycleDateInvalid ? (
                    <p className="text-xs text-destructive">End date must be on or after the start date.</p>
                  ) : null}
                </form>
              </div>

              <div className="border-b border-border px-3 py-2">
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
                    <div className="font-semibold tabular-nums text-foreground">{totals.activeCycles}</div>
                    <div className="text-muted-foreground">active</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
                    <div className="font-semibold tabular-nums text-foreground">{totals.openStoryPoints}</div>
                    <div className="text-muted-foreground">open pts</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
                    <div className="font-semibold tabular-nums text-foreground">{velocity.averagePoints}</div>
                    <div className="text-muted-foreground">velocity</div>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5" />
                  <span>
                    {velocity.completedCycleCount > 0
                      ? `${velocity.averagePoints} pts / ${velocity.averageHours}h average across ${velocity.completedCycleCount} completed cycles`
                      : "Velocity starts after the first completed cycle"}
                  </span>
                </div>
              </div>

              <div className="border-b border-border px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  {CYCLE_STATUS_FILTERS.map((filter) => {
                    const count = filter.value === "all"
                      ? filterCounts.all
                      : filter.value === "unassigned"
                        ? filterCounts.unassigned
                        : filterCounts[filter.value];
                    return (
                      <button
                        key={filter.value}
                        type="button"
                        className={cn(
                          "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium",
                          cycleStatusFilter === filter.value
                            ? "border-foreground bg-foreground text-background"
                            : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                        onClick={() => {
                          setCycleStatusFilter(filter.value);
                          if (filter.value === "unassigned") {
                            setSelectedCycleId("unassigned");
                          } else if (selectedCycleId === "unassigned") {
                            setSelectedCycleId("all");
                          }
                        }}
                      >
                        {filter.label}
                        <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-auto">
                <button
                  type="button"
                  onClick={() => setSelectedCycleId("all")}
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left hover:bg-muted/40",
                    selectedCycleId === "all" && "bg-accent/40",
                  )}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                    <RefreshCw className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">Cycle overview</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {totals.openIssues} open assigned / {totals.cycles} cycles
                    </span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{totals.progressPercent}%</span>
                </button>

                {filteredSummaries.map((summary) => (
                  <button
                    key={summary.id}
                    type="button"
                    onClick={() => setSelectedCycleId(summary.id)}
                    className={cn(
                      "flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left hover:bg-muted/40",
                      selectedCycleId === summary.id && "bg-accent/40",
                    )}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                      {summary.cycle?.status === "active" ? <Play className="h-4 w-4 text-emerald-500" /> :
                        summary.cycle?.status === "completed" ? <Lock className="h-4 w-4" /> :
                          summary.id === "unassigned" ? <Archive className="h-4 w-4" /> :
                            <CalendarClock className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{summary.label}</span>
                        {summary.cycle ? (
                          <span className={cn("shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] capitalize", statusClassName(summary.cycle.status))}>
                            {statusLabel(summary.cycle.status)}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {summary.projectLabel} · {summary.dateLabel}
                      </span>
                      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                        <span
                          className={cn(
                            "block h-full rounded-full",
                            summary.cycle?.status === "completed" ? "bg-muted-foreground" : "bg-emerald-500",
                          )}
                          style={{ width: `${summary.progressPercent}%` }}
                        />
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      <span className="block tabular-nums text-foreground">{summary.openCount} open</span>
                      <span className="block tabular-nums">{summary.openStoryPoints} pts</span>
                    </span>
                  </button>
                ))}

                {filteredSummaries.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No cycles match this view.
                  </div>
                ) : null}
              </div>
            </section>

            <section className="min-w-0 rounded-md border border-border bg-background shadow-sm">
              <div className="border-b border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-base font-semibold text-foreground">
                        {selectedCycleId === "all" ? "Cycle overview" : selectedSummary?.label ?? "Cycle work"}
                      </h2>
                      {selectedCycle ? (
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs capitalize", statusClassName(selectedCycle.status))}>
                          {statusLabel(selectedCycle.status)}
                        </span>
                      ) : selectedCycleId === "unassigned" ? (
                        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">backlog</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedCycle
                        ? `${projectName(projects, selectedCycle.projectId)} · ${formatDateRange(selectedCycle)}`
                        : selectedCycleId === "unassigned"
                          ? "Open work that has not been planned into a cycle."
                          : "Active, upcoming, and completed cycles. Open backlog only when you are planning scope."}
                    </p>
                  </div>

                  {selectedCycle ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedCycle.status === "planned" ? (
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          disabled={!canStartSelectedCycle || updateCycle.isPending}
                          onClick={() => handleCycleStatusChange(selectedCycle, {
                            status: "active",
                            startDate: selectedCycle.startDate ?? todayDateInputValue(),
                          })}
                          title={activePeerCycle ? `Complete ${activePeerCycle.name} first for this scope.` : undefined}
                        >
                          <Play className="h-3.5 w-3.5" />
                          Start
                        </button>
                      ) : null}
                      {selectedCycle.status === "active" || selectedCycle.status === "planned" ? (
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          disabled={updateCycle.isPending}
                          onClick={() => handleCycleStatusChange(selectedCycle, {
                            status: "completed",
                            endDate: selectedCycle.endDate ?? todayDateInputValue(),
                          })}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Complete
                        </button>
                      ) : null}
                      {selectedCycle.status === "completed" ? (
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          disabled={updateCycle.isPending}
                          onClick={() => handleCycleStatusChange(selectedCycle, { status: "active" })}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Reopen
                        </button>
                      ) : null}
                      {selectedCycle.status !== "archived" ? (
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          disabled={updateCycle.isPending}
                          onClick={() => handleCycleStatusChange(selectedCycle, { status: "archived" })}
                        >
                          <Archive className="h-3.5 w-3.5" />
                          Archive
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {activePeerCycle ? (
                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
                    {activePeerCycle.name} is already active for this scope. Complete it before starting this cycle.
                  </div>
                ) : null}

                <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Progress</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-lg font-semibold tabular-nums text-foreground">{detailMetrics.progressPercent}%</span>
                      <span className="text-xs text-muted-foreground">{detailMetrics.completedCount}/{detailMetrics.issueCount} done</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-emerald-500" style={{ width: `${detailMetrics.progressPercent}%` }} />
                    </div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Scope</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{detailMetrics.openStoryPoints} pts</div>
                    <div className="text-xs text-muted-foreground">{detailMetrics.openCount} open / {detailMetrics.storyPoints} total pts</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="text-xs text-muted-foreground">Estimate</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{detailMetrics.openEstimateHours}h</div>
                    <div className="text-xs text-muted-foreground">{detailMetrics.estimateHours}h committed</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="text-xs text-muted-foreground">AI actual</div>
                    <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatActualAiTime(detailMetrics.actualAiSeconds)}</div>
                    <div className="text-xs text-muted-foreground">from issue run time</div>
                  </div>
                </div>

                {selectedCycle ? (
                  <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
                    <div className="rounded-md border border-border bg-muted/20 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                        <span>Capacity</span>
                        <span>{dateInputValue(selectedCycle.startDate) || "No start"} to {dateInputValue(selectedCycle.endDate) || "No end"}</span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <div>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">Story points</span>
                            <span className="tabular-nums text-foreground">
                              {detailMetrics.storyPoints}{detailMetrics.capacityStoryPoints ? ` / ${detailMetrics.capacityStoryPoints}` : ""}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn("h-full rounded-full", pointsCapacityPercent && pointsCapacityPercent > 100 ? "bg-destructive" : "bg-blue-500")}
                              style={{ width: `${Math.min(pointsCapacityPercent ?? detailMetrics.progressPercent, 100)}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">Hours</span>
                            <span className="tabular-nums text-foreground">
                              {detailMetrics.estimateHours}{detailMetrics.capacityHours ? ` / ${detailMetrics.capacityHours}` : ""}h
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn("h-full rounded-full", hoursCapacityPercent && hoursCapacityPercent > 100 ? "bg-destructive" : "bg-amber-500")}
                              style={{ width: `${Math.min(hoursCapacityPercent ?? detailMetrics.progressPercent, 100)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-md border border-border bg-muted/20 p-3">
                      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
                        <ChevronsRight className="h-3.5 w-3.5 text-muted-foreground" />
                        Carry-forward open work
                      </div>
                      <div className="flex gap-2">
                        <select
                          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
                          value={transferTargetCycleId}
                          onChange={(event) => setTransferTargetCycleId(event.target.value)}
                          disabled={transferTargetCycles.length === 0 || transferOpenWork.isPending}
                        >
                          {transferTargetCycles.length === 0 ? (
                            <option value="">No compatible next cycle</option>
                          ) : transferTargetCycles.map((cycle) => (
                            <option key={cycle.id} value={cycle.id}>{cycle.name}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          disabled={!transferTargetCycleId || transferOpenIssueIds.length === 0 || transferOpenWork.isPending}
                          onClick={() => transferOpenWork.mutate({
                            targetCycleId: transferTargetCycleId,
                            issueIds: transferOpenIssueIds,
                          })}
                        >
                          Transfer
                        </button>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {transferOpenIssueIds.length} open issue{transferOpenIssueIds.length === 1 ? "" : "s"} ready to move.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="p-4">
                {selectedCycleId === "all" ? (
                  <CycleOverviewPanel
                    summaries={summaries}
                    backlogCount={filterCounts.unassigned}
                    onSelectCycle={setSelectedCycleId}
                    onOpenBacklog={() => {
                      setCycleStatusFilter("unassigned");
                      setSelectedCycleId("unassigned");
                    }}
                  />
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          {selectedCycleId === "unassigned" ? "Backlog planning queue" : "Cycle work items"}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          {selectedCycleId === "unassigned"
                            ? "Assign these items into an active or upcoming cycle when you are planning scope."
                            : "Set the cycle directly here, or open the issue properties panel for deeper planning."}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">{visibleIssues.length} shown</span>
                    </div>

                    {visibleIssues.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                        No work items in this cycle view.
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[980px] text-sm">
                          <thead className="text-xs uppercase text-muted-foreground">
                            <tr className="border-b border-border text-left">
                              <th className="py-2 pr-3 font-medium">Issue</th>
                              <th className="px-3 py-2 font-medium">Project</th>
                              <th className="px-3 py-2 font-medium">Cycle</th>
                              <th className="px-3 py-2 font-medium">Status</th>
                              <th className="px-3 py-2 font-medium">Priority</th>
                              <th className="px-3 py-2 font-medium">Points</th>
                              <th className="px-3 py-2 font-medium">Estimate</th>
                              <th className="px-3 py-2 font-medium">AI Time</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {visibleIssues.map((issue) => {
                              const project = issue.projectId ? projects?.find((item) => item.id === issue.projectId) : null;
                              const cycleOptions = cycleOptionsForIssue(issue);
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
                                  <td className="px-3 py-3">
                                    <select
                                      className="h-8 w-48 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                                      value={issue.cycleId ?? ""}
                                      disabled={updateIssueCycle.isPending}
                                      onChange={(event) => updateIssueCycle.mutate({
                                        issueId: issue.id,
                                        cycleId: event.target.value || null,
                                      })}
                                    >
                                      <option value="">No cycle</option>
                                      {cycleOptions.map((cycle) => (
                                        <option
                                          key={cycle.id}
                                          value={cycle.id}
                                          disabled={cycle.status === "completed" && cycle.id !== issue.cycleId}
                                        >
                                          {cycle.name}{cycle.status === "completed" ? " (locked)" : ""}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="px-3 py-3">
                                    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs capitalize", issueStatusClassName(issue.status))}>
                                      {issueStatusLabel(issue.status)}
                                    </span>
                                  </td>
                                  <td className="px-3 py-3 capitalize text-muted-foreground">{issue.priority}</td>
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

                    {issues.length >= CYCLE_PAGE_SIZE ? (
                      <div className="mt-3 text-xs text-muted-foreground">
                        Showing first {CYCLE_PAGE_SIZE} loaded issues.
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
