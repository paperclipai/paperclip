import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { workCyclesApi } from "../api/work-cycles";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildCompanyUserLabelMap } from "../lib/company-members";
import { cn, projectUrl } from "../lib/utils";
import { buildIssueValueWithDescendantsMap, sumIssueValuesWithDescendants } from "../lib/issue-rollups";
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
  Users,
} from "lucide-react";
import type {
  Agent,
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
  { value: "archived", label: "Archived" },
];

type CycleSelection = "all" | string;
type CycleStatusFilter = "all" | WorkCycle["status"];

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
  actualHumanSeconds: number;
  actualAiSeconds: number;
  progressPercent: number;
  capacityStoryPoints: number | null;
  capacityHours: number | null;
};

type CycleAssignmentRow = {
  id: string;
  kind: "user" | "agent" | "unassigned";
  label: string;
  issueCount: number;
  openCount: number;
  blockedCount: number;
  storyPoints: number;
  openStoryPoints: number;
  estimateHours: number;
  openEstimateHours: number;
  actualHumanSeconds: number;
  actualAiSeconds: number;
  capacityHours: number | null;
  capacityPercent: number | null;
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

function actualHumanSecondsForIssue(issue: Issue) {
  if (typeof issue.actualHumanSeconds !== "number" || !Number.isFinite(issue.actualHumanSeconds)) return 0;
  return Math.max(0, issue.actualHumanSeconds);
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

function ownerKeyForIssue(issue: Issue) {
  if (issue.assigneeUserId) return `user:${issue.assigneeUserId}`;
  if (issue.assigneeAgentId) return `agent:${issue.assigneeAgentId}`;
  return "unassigned";
}

function ownerLabelForIssue(
  issue: Issue,
  agentsById: ReadonlyMap<string, Agent>,
  currentUserId: string | null,
  userLabelMap: ReadonlyMap<string, string>,
) {
  if (issue.assigneeUserId) {
    return formatAssigneeUserLabel(issue.assigneeUserId, currentUserId, userLabelMap) ?? "User";
  }
  if (issue.assigneeAgentId) {
    return agentsById.get(issue.assigneeAgentId)?.name ?? issue.assigneeAgentId.slice(0, 8);
  }
  return "Unassigned";
}

function ownerKindForIssue(issue: Issue): CycleAssignmentRow["kind"] {
  if (issue.assigneeUserId) return "user";
  if (issue.assigneeAgentId) return "agent";
  return "unassigned";
}

function buildCycleAssignments(args: {
  issues: Issue[];
  capacityHours: number | null;
  agentsById: ReadonlyMap<string, Agent>;
  currentUserId: string | null;
  userLabelMap: ReadonlyMap<string, string>;
  actualHumanSecondsByIssue: ReadonlyMap<string, number>;
  actualAiSecondsByIssue: ReadonlyMap<string, number>;
}) {
  const rowsByOwner = new Map<string, CycleAssignmentRow>();
  for (const issue of args.issues) {
    const ownerKey = ownerKeyForIssue(issue);
    const row = rowsByOwner.get(ownerKey) ?? {
      id: ownerKey,
      kind: ownerKindForIssue(issue),
      label: ownerLabelForIssue(issue, args.agentsById, args.currentUserId, args.userLabelMap),
      issueCount: 0,
      openCount: 0,
      blockedCount: 0,
      storyPoints: 0,
      openStoryPoints: 0,
      estimateHours: 0,
      openEstimateHours: 0,
      actualHumanSeconds: 0,
      actualAiSeconds: 0,
      capacityHours: null,
      capacityPercent: null,
    };

    const points = pointsForIssue(issue);
    const estimateHours = estimateHoursForIssue(issue);
    const open = isOpenIssue(issue);
    row.issueCount += 1;
    row.storyPoints += points;
    row.estimateHours += estimateHours;
    row.actualHumanSeconds += args.actualHumanSecondsByIssue.get(issue.id) ?? actualHumanSecondsForIssue(issue);
    row.actualAiSeconds += args.actualAiSecondsByIssue.get(issue.id) ?? actualAiSecondsForIssue(issue);
    if (open) {
      row.openCount += 1;
      row.openStoryPoints += points;
      row.openEstimateHours += estimateHours;
    }
    if (issue.status === "blocked") row.blockedCount += 1;
    rowsByOwner.set(ownerKey, row);
  }

  const assignedOwnerCount = [...rowsByOwner.values()].filter((row) => row.kind !== "unassigned").length;
  const defaultCapacityPerOwner = args.capacityHours && assignedOwnerCount > 0
    ? args.capacityHours / assignedOwnerCount
    : null;
  return [...rowsByOwner.values()]
    .map((row) => {
      const capacityHours = row.kind === "unassigned" ? null : defaultCapacityPerOwner;
      return {
        ...row,
        capacityHours,
        capacityPercent: capacityHours ? Math.round((row.estimateHours / capacityHours) * 100) : null,
      };
    })
    .sort((a, b) => {
      if (a.kind === "unassigned" && b.kind !== "unassigned") return 1;
      if (b.kind === "unassigned" && a.kind !== "unassigned") return -1;
      return b.estimateHours - a.estimateHours || b.storyPoints - a.storyPoints || a.label.localeCompare(b.label);
    });
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
  allIssues: Issue[],
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
    actualHumanSeconds: sumIssues(issues, actualHumanSecondsForIssue),
    actualAiSeconds: sumIssueValuesWithDescendants(issues, allIssues, actualAiSecondsForIssue),
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
    issues,
  ));

  return summaries.sort((a, b) => {
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
  onSelectCycle: (cycleId: CycleSelection) => void;
  onCreateCycle: () => void;
};

function CycleOverviewPanel({
  summaries,
  onSelectCycle,
  onCreateCycle,
}: CycleOverviewPanelProps) {
  const cycleSummaries = summaries.filter(
    (summary): summary is CycleSummary & { cycle: WorkCycle } =>
      !!summary.cycle,
  );

  return (
    <div className="space-y-3">
      {cycleSummaries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border px-4 py-12 text-center">
          <div className="text-sm font-medium text-foreground">No cycles in this view.</div>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Create a cycle, then add issues from the selected cycle detail or from each issue's properties.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
            onClick={onCreateCycle}
          >
            <Plus className="h-3.5 w-3.5" />
            New cycle
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[minmax(0,1.8fr)_minmax(120px,0.8fr)_minmax(160px,1fr)_minmax(120px,0.7fr)] border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium uppercase tracking-normal text-muted-foreground max-lg:hidden">
            <span>Cycle</span>
            <span>Status</span>
            <span>Scope</span>
            <span className="text-right">Progress</span>
          </div>
          <div className="divide-y divide-border">
            {cycleSummaries.map((summary) => (
              <button
                key={summary.id}
                type="button"
                className="grid w-full gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 lg:grid-cols-[minmax(0,1.8fr)_minmax(120px,0.8fr)_minmax(160px,1fr)_minmax(120px,0.7fr)] lg:items-center"
                onClick={() => onSelectCycle(summary.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{summary.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {summary.projectLabel} · {summary.dateLabel}
                  </span>
                </span>
                <span>
                  <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs capitalize", statusClassName(summary.cycle.status))}>
                    {statusLabel(summary.cycle.status)}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="tabular-nums">{summary.openCount} open</span>
                  <span className="tabular-nums">{summary.openStoryPoints} pts</span>
                  <span className="tabular-nums">{summary.openEstimateHours}h</span>
                </span>
                <span className="min-w-0">
                  <span className="mb-1 block text-right text-xs tabular-nums text-muted-foreground">
                    {summary.progressPercent}%
                  </span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn("block h-full rounded-full", summary.cycle.status === "completed" ? "bg-muted-foreground" : "bg-emerald-500")}
                      style={{ width: `${summary.progressPercent}%` }}
                    />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
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
  const [newCycleOpen, setNewCycleOpen] = useState(false);
  const [transferTargetCycleId, setTransferTargetCycleId] = useState("");
  const [addWorkOpen, setAddWorkOpen] = useState(false);

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

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );

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
      setNewCycleOpen(false);
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
  const actualHumanSecondsByIssue = useMemo(
    () => new Map(issues.map((issue) => [issue.id, actualHumanSecondsForIssue(issue)])),
    [issues],
  );
  const actualAiSecondsByIssueWithDescendants = useMemo(
    () => buildIssueValueWithDescendantsMap(issues, actualAiSecondsForIssue),
    [issues],
  );
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
  }), [cycles]);

  const filteredSummaries = useMemo(() => {
    const normalizedQuery = cycleSearch.trim().toLowerCase();
    return summaries.filter((summary) => {
      if (summary.cycle) {
        if (cycleStatusFilter === "all" && summary.cycle.status === "archived") return false;
        if (cycleStatusFilter !== "all" && summary.cycle.status !== cycleStatusFilter) return false;
      }
      if (!normalizedQuery) return true;
      return [
        summary.label,
        summary.projectLabel,
        summary.dateLabel,
        summary.cycle?.status ?? "",
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
      actualHumanSeconds: sumIssues(cycleAssignedIssues, actualHumanSecondsForIssue),
      actualAiSeconds: sumIssueValuesWithDescendants(cycleAssignedIssues, issues, actualAiSecondsForIssue),
      progressPercent: cycleAssignedIssues.length > 0
        ? clampPercent((cycleAssignedCompletedIssues.length / cycleAssignedIssues.length) * 100)
        : 0,
    };
  }, [cycleAssignedCompletedIssues, cycleAssignedIssues, cycleAssignedOpenIssues, cycles, issues]);

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
  const addWorkCandidates = useMemo(() => {
    if (!selectedCycle) return [];
    return unassignedOpenIssues
      .filter((issue) => isAssignableCycleForIssue(selectedCycle, issue))
      .sort((a, b) => {
        const priorityDelta = (PRIORITY_POINTS[b.priority] ?? 0) - (PRIORITY_POINTS[a.priority] ?? 0);
        if (priorityDelta !== 0) return priorityDelta;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
  }, [selectedCycle, unassignedOpenIssues]);
  const detailMetrics = selectedSummary ?? {
    issueCount: totals.allIssues,
    openCount: totals.openIssues,
    completedCount: cycleAssignedCompletedIssues.length,
    storyPoints: totals.storyPoints,
    openStoryPoints: totals.openStoryPoints,
    completedStoryPoints: totals.completedStoryPoints,
    estimateHours: totals.estimateHours,
    openEstimateHours: totals.openEstimateHours,
    actualHumanSeconds: totals.actualHumanSeconds,
    actualAiSeconds: totals.actualAiSeconds,
    progressPercent: totals.progressPercent,
    capacityStoryPoints: null,
    capacityHours: null,
    issues: cycleAssignedIssues,
    openIssues: cycleAssignedOpenIssues,
    completedIssues: cycleAssignedCompletedIssues,
  };
  const cycleAssignments = useMemo(() => buildCycleAssignments({
    issues: selectedSummary?.issues ?? [],
    capacityHours: selectedSummary?.capacityHours ?? null,
    agentsById,
    currentUserId,
    userLabelMap,
    actualHumanSecondsByIssue,
    actualAiSecondsByIssue: actualAiSecondsByIssueWithDescendants,
  }), [
    actualHumanSecondsByIssue,
    actualAiSecondsByIssueWithDescendants,
    agentsById,
    currentUserId,
    selectedSummary,
    userLabelMap,
  ]);
  const assignedCapacityOwners = useMemo(
    () => cycleAssignments.filter((row) => row.kind !== "unassigned").length,
    [cycleAssignments],
  );
  const teamCapacityRemaining = detailMetrics.capacityHours === null
    ? null
    : detailMetrics.capacityHours - detailMetrics.estimateHours;
  const maxAssignmentHours = Math.max(
    1,
    detailMetrics.capacityHours ?? 0,
    ...cycleAssignments.map((row) => row.estimateHours),
  );

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

  useEffect(() => {
    setAddWorkOpen(false);
  }, [selectedCycleId]);

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
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
              onClick={() => setNewCycleOpen(true)}
            >
              <Plus className="h-3.5 w-3.5" />
              New cycle
            </button>
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
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">Cycles</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {filteredSummaries.length} shown · {totals.activeCycles} active · {velocity.averagePoints} pt velocity
                    </p>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent"
                    onClick={() => setNewCycleOpen((open) => !open)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {newCycleOpen ? "Close" : "New"}
                  </button>
                </div>

                {newCycleOpen ? (
                  <form className="mt-3 space-y-2 rounded-md border border-border bg-muted/20 p-3" onSubmit={handleCreateCycle}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-muted-foreground">Scope: {selectedProjectLabel}</p>
                      <button
                        type="submit"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90 disabled:opacity-50"
                        disabled={!newCycle.name.trim() || newCycleDateInvalid || createCycle.isPending}
                      >
                        Create
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
                ) : null}
              </div>

              <div className="border-b border-border px-3 py-2">
                <div className="flex flex-wrap gap-1.5">
                  {CYCLE_STATUS_FILTERS.map((filter) => {
                    const count = filter.value === "all"
                      ? filterCounts.all
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
                        {selectedCycleId === "all" ? "All cycles" : selectedSummary?.label ?? "Cycle work"}
                      </h2>
                      {selectedCycle ? (
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs capitalize", statusClassName(selectedCycle.status))}>
                          {statusLabel(selectedCycle.status)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {selectedCycle
                        ? `${projectName(projects, selectedCycle.projectId)} · ${formatDateRange(selectedCycle)}`
                        : "Select a cycle to inspect scope, add work, and evaluate progress."}
                    </p>
                  </div>

                  {selectedCycle ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent"
                        onClick={() => setSelectedCycleId("all")}
                      >
                        All cycles
                      </button>
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
                      {selectedCycle.status !== "completed" && selectedCycle.status !== "archived" ? (
                        <button
                          type="button"
                          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          onClick={() => setAddWorkOpen((open) => !open)}
                          disabled={addWorkCandidates.length === 0}
                          title={addWorkCandidates.length === 0 ? "No compatible unplanned work for this cycle." : undefined}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add work
                          <span className="text-xs tabular-nums text-muted-foreground">{addWorkCandidates.length}</span>
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

                {selectedCycle ? (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
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
                      <div className="text-xs text-muted-foreground">Human actual</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatActualAiTime(detailMetrics.actualHumanSeconds)}</div>
                      <div className="text-xs text-muted-foreground">from issue lifecycle time</div>
                    </div>
                    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="text-xs text-muted-foreground">AI actual</div>
                      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatActualAiTime(detailMetrics.actualAiSeconds)}</div>
                      <div className="text-xs text-muted-foreground">from issue run time</div>
                    </div>
                  </div>
                ) : null}

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

                {selectedCycle ? (
                  <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Users className="h-4 w-4 text-muted-foreground" />
                          Team assignment
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {detailMetrics.capacityHours !== null
                            ? `${detailMetrics.capacityHours}h team capacity · ${detailMetrics.estimateHours}h committed · ${teamCapacityRemaining! >= 0 ? `${teamCapacityRemaining}h free` : `${Math.abs(teamCapacityRemaining!)}h over`}`
                            : `${detailMetrics.estimateHours}h committed across ${cycleAssignments.length} owner${cycleAssignments.length === 1 ? "" : "s"}`}
                        </p>
                      </div>
                      {detailMetrics.capacityHours !== null && assignedCapacityOwners > 0 ? (
                        <div className="rounded-md border border-border bg-background px-2.5 py-1.5 text-right">
                          <div className="text-[11px] text-muted-foreground">Even-share capacity</div>
                          <div className="text-sm font-medium tabular-nums text-foreground">
                            {Math.round(detailMetrics.capacityHours / assignedCapacityOwners)}h / owner
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 space-y-2">
                      {cycleAssignments.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                          No assigned work in this cycle.
                        </div>
                      ) : cycleAssignments.map((row) => {
                        const width = row.capacityHours
                          ? Math.min(row.capacityPercent ?? 0, 100)
                          : Math.max(6, Math.round((row.estimateHours / maxAssignmentHours) * 100));
                        const overCapacity = row.capacityPercent !== null && row.capacityPercent > 100;
                        return (
                          <div
                            key={row.id}
                            className={cn(
                              "rounded-md border bg-background px-3 py-2",
                              overCapacity ? "border-destructive/40" : "border-border",
                              row.kind === "unassigned" && "border-amber-500/30 bg-amber-500/5",
                            )}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
                                  <span className={cn(
                                    "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] capitalize",
                                    row.kind === "agent"
                                      ? "border-purple-500/30 bg-purple-500/10 text-purple-500"
                                      : row.kind === "user"
                                        ? "border-blue-500/30 bg-blue-500/10 text-blue-500"
                                        : "border-amber-500/30 bg-amber-500/10 text-amber-600",
                                  )}>
                                    {row.kind === "agent" ? "AI" : row.kind === "user" ? "Human" : "No owner"}
                                  </span>
                                  {overCapacity ? (
                                    <span className="shrink-0 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
                                      Over capacity
                                    </span>
                                  ) : null}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span>{row.openCount}/{row.issueCount} open</span>
                                  <span>{row.openStoryPoints}/{row.storyPoints} pts</span>
                                  <span>{row.openEstimateHours}/{row.estimateHours}h open/committed</span>
                                  {row.blockedCount > 0 ? <span>{row.blockedCount} blocked</span> : null}
                                  {row.actualHumanSeconds > 0 ? <span>{formatActualAiTime(row.actualHumanSeconds)} human</span> : null}
                                  {row.actualAiSeconds > 0 ? <span>{formatActualAiTime(row.actualAiSeconds)} AI</span> : null}
                                </div>
                              </div>
                              <div className="shrink-0 text-right">
                                <div className="text-sm font-medium tabular-nums text-foreground">
                                  {row.estimateHours}h{row.capacityHours ? ` / ${Math.round(row.capacityHours)}h` : ""}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {row.capacityPercent !== null ? `${row.capacityPercent}%` : "no capacity share"}
                                </div>
                              </div>
                            </div>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  overCapacity ? "bg-destructive" : row.kind === "unassigned" ? "bg-amber-500" : "bg-emerald-500",
                                )}
                                style={{ width: `${width}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {selectedCycle && addWorkOpen ? (
                  <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold text-foreground">Add unplanned work</div>
                        <div className="text-xs text-muted-foreground">
                          Compatible open issues without a cycle. This list stays hidden until you plan scope.
                        </div>
                      </div>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {addWorkCandidates.length} available
                      </span>
                    </div>
                    {addWorkCandidates.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                        No compatible unplanned work for this cycle.
                      </div>
                    ) : (
                      <div className="max-h-72 overflow-auto rounded-md border border-border bg-background">
                        {addWorkCandidates.slice(0, 50).map((issue) => {
                          const project = issue.projectId ? projects?.find((item) => item.id === issue.projectId) : null;
                          return (
                            <div key={issue.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
                              <div className="min-w-0 flex-1">
                                <Link to={`/issues/${issue.identifier ?? issue.id}`} className="block min-w-0">
                                  <span className="mr-2 font-mono text-xs text-muted-foreground">
                                    {issue.identifier ?? issue.id.slice(0, 8)}
                                  </span>
                                  <span className="text-sm font-medium text-foreground">{issue.title}</span>
                                </Link>
                                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span>{project?.name ?? "No project"}</span>
                                  <span>{pointsForIssue(issue)} pts</span>
                                  <span>{estimateHoursForIssue(issue)}h</span>
                                  <span className="capitalize">{issue.priority}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
                                disabled={updateIssueCycle.isPending}
                                onClick={() => updateIssueCycle.mutate({
                                  issueId: issue.id,
                                  cycleId: selectedCycle.id,
                                })}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add
                              </button>
                            </div>
                          );
                        })}
                        {addWorkCandidates.length > 50 ? (
                          <div className="px-3 py-2 text-xs text-muted-foreground">
                            Showing first 50 compatible issues. Use issue filters to narrow the backlog before planning.
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="p-4">
                {selectedCycleId === "all" ? (
                  <CycleOverviewPanel
                    summaries={filteredSummaries}
                    onSelectCycle={setSelectedCycleId}
                    onCreateCycle={() => setNewCycleOpen(true)}
                  />
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">
                          Cycle work items
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Set the cycle directly here, or open the issue properties panel for deeper planning.
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
                              <th className="px-3 py-2 font-medium">Human Time</th>
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
                                  <td className="px-3 py-3 tabular-nums text-foreground">
                                    {formatActualAiTime(actualHumanSecondsByIssue.get(issue.id) ?? actualHumanSecondsForIssue(issue))}
                                  </td>
                                  <td className="px-3 py-3 tabular-nums text-foreground">
                                    {formatActualAiTime(actualAiSecondsByIssueWithDescendants.get(issue.id) ?? actualAiSecondsForIssue(issue))}
                                  </td>
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
