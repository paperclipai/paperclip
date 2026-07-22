import type { ExternalObjectSummary, Issue } from "@paperclipai/shared";

export type IssueFilterWorkspaceLookup = {
  mode?: string | null;
  projectWorkspaceId?: string | null;
};

export type IssueFilterWorkspaceContext = {
  executionWorkspaceById?: ReadonlyMap<string, IssueFilterWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
  externalObjectSummaryByIssueId?: ReadonlyMap<string, ExternalObjectSummary>;
  externalObjectSummariesReady?: boolean;
};

export type IssueFilterState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  creators: string[];
  labels: string[];
  projects: string[];
  workspaces: string[];
  liveOnly?: boolean;
  /**
   * External object status filter. Values are special tokens that map to
   * properties of the issue's external-object summary (rather than to a
   * single category) so the filter UI can describe intent rather than every
   * possible permutation.
   *
   *   - `failed`         — any external object with `statusCategory in (failed, blocked)`
   *   - `waiting`        — any external object with `statusCategory in (waiting)`
   *   - `running`        — any external object with `statusCategory in (running)`
   *   - `auth_required`  — any external object with `liveness == auth_required`
   *   - `unreachable`    — any external object with `liveness == unreachable`
   *   - `stale`          — any external object with `liveness == stale`
   *   - `none`           — issues with zero external objects
   */
  externalObjectStatuses: string[];
  hideRoutineExecutions: boolean;
};

export const defaultIssueFilterState: IssueFilterState = {
  statuses: [],
  priorities: [],
  assignees: [],
  creators: [],
  labels: [],
  projects: [],
  workspaces: [],
  liveOnly: false,
  externalObjectStatuses: [],
  hideRoutineExecutions: false,
};

export const externalObjectFilterOrder = [
  "failed",
  "waiting",
  "running",
  "auth_required",
  "unreachable",
  "stale",
  "none",
];

const EXTERNAL_OBJECT_FILTER_LABELS: Record<string, string> = {
  failed: "Any failed",
  waiting: "Any waiting",
  running: "Any running",
  auth_required: "Auth required",
  unreachable: "Unreachable",
  stale: "Stale",
  none: "No external objects",
};

export function externalObjectFilterLabel(value: string): string {
  return EXTERNAL_OBJECT_FILTER_LABELS[value] ?? issueFilterLabel(value);
}

export const issueStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export const issueQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function issueFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function issueFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function normalizeIssueFilterValueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeIssueFilterState(value: unknown): IssueFilterState {
  if (!value || typeof value !== "object") return { ...defaultIssueFilterState };
  const candidate = value as Partial<Record<keyof IssueFilterState, unknown>>;
  return {
    statuses: normalizeIssueFilterValueArray(candidate.statuses),
    priorities: normalizeIssueFilterValueArray(candidate.priorities),
    assignees: normalizeIssueFilterValueArray(candidate.assignees),
    creators: normalizeIssueFilterValueArray(candidate.creators),
    labels: normalizeIssueFilterValueArray(candidate.labels),
    projects: normalizeIssueFilterValueArray(candidate.projects),
    workspaces: normalizeIssueFilterValueArray(candidate.workspaces),
    liveOnly: candidate.liveOnly === true,
    externalObjectStatuses: normalizeIssueFilterValueArray(candidate.externalObjectStatuses),
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function toggleIssueFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function resolveIssueFilterWorkspaceId(
  issue: Pick<Issue, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  context: IssueFilterWorkspaceContext = {},
): string | null {
  const defaultProjectWorkspaceId = issue.projectId
    ? context.defaultProjectWorkspaceIdByProjectId?.get(issue.projectId) ?? null
    : null;

  if (issue.executionWorkspaceId) {
    const executionWorkspace = context.executionWorkspaceById?.get(issue.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? issue.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace"
      && linkedProjectWorkspaceId != null
      && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;
    return issue.executionWorkspaceId;
  }

  if (issue.projectWorkspaceId) {
    if (issue.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    return issue.projectWorkspaceId;
  }

  return null;
}

export function shouldIncludeIssueFilterWorkspaceOption(
  workspace: { id: string; mode?: string | null; projectWorkspaceId?: string | null },
  defaultProjectWorkspaceIds: ReadonlySet<string>,
): boolean {
  if (defaultProjectWorkspaceIds.has(workspace.id)) return false;
  return !(workspace.mode === "shared_workspace"
    && workspace.projectWorkspaceId != null
    && defaultProjectWorkspaceIds.has(workspace.projectWorkspaceId));
}

function summaryRecordCount(record: Record<string, number> | undefined, key: string): number {
  return record?.[key] ?? 0;
}

function issueMatchesExternalObjectStatusFilter(
  summary: ExternalObjectSummary | null | undefined,
  value: string,
): boolean {
  const total = summary?.total ?? 0;
  switch (value) {
    case "failed":
      return summaryRecordCount(summary?.byStatusCategory, "failed") > 0
        || summaryRecordCount(summary?.byStatusCategory, "blocked") > 0;
    case "waiting":
      return summaryRecordCount(summary?.byStatusCategory, "waiting") > 0;
    case "running":
      return summaryRecordCount(summary?.byStatusCategory, "running") > 0;
    case "auth_required":
      return (summary?.authRequiredCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "auth_required") > 0;
    case "unreachable":
      return (summary?.unreachableCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "unreachable") > 0;
    case "stale":
      return (summary?.staleCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "stale") > 0;
    case "none":
      return total === 0;
    default:
      return false;
  }
}

export function applyIssueFilters(
  issues: Issue[],
  state: IssueFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
  liveIssueIds?: ReadonlySet<string>,
  workspaceContext: IssueFilterWorkspaceContext = {},
): Issue[] {
  let result = issues;
  if (state.liveOnly) {
    result = result.filter((issue) => liveIssueIds?.has(issue.id) === true);
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    result = result.filter((issue) => issue.originKind !== "routine_execution");
  }
  if (state.statuses.length > 0) result = result.filter((issue) => state.statuses.includes(issue.status));
  if (state.priorities.length > 0) result = result.filter((issue) => state.priorities.includes(issue.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((issue) => {
      for (const creator of state.creators) {
        if (creator.startsWith("agent:") && issue.createdByAgentId === creator.slice("agent:".length)) return true;
        if (creator.startsWith("user:") && issue.createdByUserId === creator.slice("user:".length)) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((issue) => (issue.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  if (state.projects.length > 0) {
    result = result.filter((issue) => issue.projectId != null && state.projects.includes(issue.projectId));
  }
  if (state.workspaces.length > 0) {
    result = result.filter((issue) => {
      const workspaceId = resolveIssueFilterWorkspaceId(issue, workspaceContext);
      return workspaceId != null && state.workspaces.includes(workspaceId);
    });
  }
  if (state.externalObjectStatuses.length > 0) {
    const summaries = workspaceContext.externalObjectSummaryByIssueId;
    if (!summaries || workspaceContext.externalObjectSummariesReady !== true) return [];
    result = result.filter((issue) => {
      const summary = summaries.get(issue.id) ?? null;
      return state.externalObjectStatuses.some((status) =>
        issueMatchesExternalObjectStatusFilter(summary, status),
      );
    });
  }
  return result;
}

export function countActiveIssueFilters(
  state: IssueFilterState,
  enableRoutineVisibilityFilter = false,
): number {
  let count = 0;
  if (state.statuses.length > 0) count += 1;
  if (state.priorities.length > 0) count += 1;
  if (state.assignees.length > 0) count += 1;
  if (state.creators.length > 0) count += 1;
  if (state.labels.length > 0) count += 1;
  if (state.projects.length > 0) count += 1;
  if (state.workspaces.length > 0) count += 1;
  if (state.liveOnly) count += 1;
  if (state.externalObjectStatuses.length > 0) count += 1;
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) count += 1;
  return count;
}
