import { isAgentCreatedIssue, type ExternalObjectSummary, type Issue } from "@paperclipai/shared";

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
  showAgentCreatedTasks: boolean;
  routineTasksOnly?: boolean;
  /**
   * Keep tasks whose row time ("Updated X ago") is inside this window. `custom`
   * uses `updatedFrom` and `updatedTo`, local calendar days in `YYYY-MM-DD`.
   */
  updatedWithin?: IssueUpdatedWithin | null;
  updatedFrom?: string | null;
  updatedTo?: string | null;
};

export type IssueUpdatedWithin = "24h" | "3d" | "7d" | "30d" | "custom";

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
  showAgentCreatedTasks: false,
  routineTasksOnly: false,
  updatedWithin: null,
  updatedFrom: null,
  updatedTo: null,
};

const HOUR_MS = 60 * 60 * 1000;

const ISSUE_UPDATED_WINDOW_MS: Record<Exclude<IssueUpdatedWithin, "custom">, number> = {
  "24h": 24 * HOUR_MS,
  "3d": 3 * 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};

/** Same words as the Search page's "Updated within" filter, plus 3 days. */
export const issueUpdatedWithinOptions: ReadonlyArray<{ value: IssueUpdatedWithin | null; label: string }> = [
  { value: null, label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "3d", label: "Last 3 days" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

const ISSUE_UPDATED_WITHIN_VALUES = new Set<string>(["24h", "3d", "7d", "30d", "custom"]);
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(value: string | null | undefined, dayOffset = 0): number | null {
  const match = value ? LOCAL_DATE_PATTERN.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // Reject impossible days such as 2026-02-31, which Date would roll into March.
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  const time = new Date(year, month, day + dayOffset).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeLocalDate(value: unknown): string | null {
  return typeof value === "string" && parseLocalDate(value) != null ? value : null;
}

/** The filter change for one Updated option. Only a custom range keeps its days. */
export function issueUpdatedWithinPatch(value: IssueUpdatedWithin | null): Partial<IssueFilterState> {
  return value === "custom" ? { updatedWithin: value } : { updatedWithin: value, updatedFrom: null, updatedTo: null };
}

/** The time a task row shows as "Updated X ago". */
export function issueUpdatedTime(
  issue: Pick<Issue, "updatedAt" | "lastActivityAt" | "lastExternalCommentAt">,
): Date | string {
  return issue.lastActivityAt ?? issue.lastExternalCommentAt ?? issue.updatedAt;
}

/**
 * The half-open `[start, end)` time range for the Updated filter, or null when it
 * does not filter. A custom range runs from the start of its first local day to
 * the end of its last local day; either end may be left open.
 */
export function issueUpdatedTimeRange(
  state: Pick<IssueFilterState, "updatedWithin" | "updatedFrom" | "updatedTo">,
  now: Date = new Date(),
): { start: number | null; end: number | null } | null {
  const within = state.updatedWithin;
  if (!within) return null;
  if (within !== "custom") return { start: now.getTime() - ISSUE_UPDATED_WINDOW_MS[within], end: null };
  let start = parseLocalDate(state.updatedFrom);
  let end = parseLocalDate(state.updatedTo, 1);
  if (start == null && end == null) return null;
  if (start != null && end != null && start >= end) {
    // A reversed pick still means "between these two days".
    start = parseLocalDate(state.updatedTo);
    end = parseLocalDate(state.updatedFrom, 1);
  }
  return { start, end };
}

/**
 * The earliest wall-clock timestamp (ms) at which one of `issues` will age out
 * of a relative Updated window (`24h`, `3d`, `7d`, `30d`), or null when no
 * relative window is active or no remaining issue can cross the boundary.
 */
export function nextIssueUpdatedFilterExpiryMs(
  issues: ReadonlyArray<Pick<Issue, "updatedAt" | "lastActivityAt" | "lastExternalCommentAt">>,
  updatedWithin: IssueUpdatedWithin | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!updatedWithin || updatedWithin === "custom") return null;
  const windowMs = ISSUE_UPDATED_WINDOW_MS[updatedWithin];
  const cutoff = nowMs - windowMs;
  let earliestExpiry: number | null = null;
  for (const issue of issues) {
    const time = new Date(issueUpdatedTime(issue)).getTime();
    if (!Number.isFinite(time) || time < cutoff) continue;
    const expiry = time + windowMs + 1;
    if (earliestExpiry === null || expiry < earliestExpiry) {
      earliestExpiry = expiry;
    }
  }
  return earliestExpiry;
}

/**
 * The server `updatedBefore` bound for a custom range's end, or undefined. The row
 * time is never older than the stored `updatedAt`, so this bound never drops a task
 * the range keeps. A start bound on `updatedAt` could, so the start stays in the browser.
 */
export function issueUpdatedServerBefore(
  state: Pick<IssueFilterState, "updatedWithin" | "updatedFrom" | "updatedTo">,
): string | undefined {
  if (state.updatedWithin !== "custom") return undefined;
  const end = issueUpdatedTimeRange(state)?.end;
  return end == null ? undefined : new Date(end).toISOString();
}

export type IssueUpdatedFilter = Pick<IssueFilterState, "updatedWithin" | "updatedFrom" | "updatedTo">;

/** Read the Updated filter from `updated`, `updatedFrom` and `updatedTo` page address values. */
export function readIssueUpdatedParams(params: URLSearchParams): IssueUpdatedFilter {
  const { updatedWithin, updatedFrom, updatedTo } = normalizeIssueFilterState({
    updatedWithin: params.get("updated"),
    updatedFrom: params.get("updatedFrom"),
    updatedTo: params.get("updatedTo"),
  });
  return updatedWithin === "custom"
    ? { updatedWithin, updatedFrom, updatedTo }
    : { updatedWithin, updatedFrom: null, updatedTo: null };
}

/** Write the Updated filter into page address values; the default removes them. */
export function writeIssueUpdatedParams(params: URLSearchParams, state: IssueUpdatedFilter): void {
  for (const key of ["updated", "updatedFrom", "updatedTo"]) params.delete(key);
  if (!state.updatedWithin) return;
  params.set("updated", state.updatedWithin);
  if (state.updatedWithin !== "custom") return;
  if (state.updatedFrom) params.set("updatedFrom", state.updatedFrom);
  if (state.updatedTo) params.set("updatedTo", state.updatedTo);
}

export const externalObjectFilterOrder = [
  "failed",
  "waiting",
  "running",
  "auth_required",
  "rate_limited",
  "unreachable",
  "stale",
  "none",
];

const EXTERNAL_OBJECT_FILTER_LABELS: Record<string, string> = {
  failed: "Any failed",
  waiting: "Any waiting",
  running: "Any running",
  auth_required: "Auth required",
  rate_limited: "Rate limited",
  unreachable: "Unreachable",
  stale: "Stale",
  none: "No external objects",
};

export function externalObjectFilterLabel(value: string): string {
  return EXTERNAL_OBJECT_FILTER_LABELS[value] ?? issueFilterLabel(value);
}

export const issueStatusOrder = ["in_progress", "monitoring", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export const issueQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "monitoring", "in_review", "blocked"] },
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
    showAgentCreatedTasks: candidate.showAgentCreatedTasks === true,
    routineTasksOnly: candidate.routineTasksOnly === true,
    updatedWithin: typeof candidate.updatedWithin === "string" && ISSUE_UPDATED_WITHIN_VALUES.has(candidate.updatedWithin)
      ? candidate.updatedWithin as IssueUpdatedWithin
      : null,
    updatedFrom: normalizeLocalDate(candidate.updatedFrom),
    updatedTo: normalizeLocalDate(candidate.updatedTo),
  };
}

export function toggleIssueFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function searchIssueFilterOptions<T>(
  options: readonly T[] | undefined,
  search: string,
  getSearchText: (option: T) => string,
): T[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  if (!normalizedSearch) return [...(options ?? [])];
  return (options ?? []).filter((option) =>
    getSearchText(option).toLocaleLowerCase().includes(normalizedSearch),
  );
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
    case "rate_limited":
      return summaryRecordCount(summary?.byLiveness, "rate_limited") > 0;
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

/** Keep creation visibility and routine origin consistent across collection reads. */
export function issueCreationRequestFilters(
  state: Pick<IssueFilterState, "routineTasksOnly" | "showAgentCreatedTasks">,
  enableAgentCreatedVisibilityFilter = false,
) {
  if (state.routineTasksOnly) {
    return { originKind: "routine_execution", includeRoutineExecutions: true, includeAgentCreatedTasks: true };
  }
  return enableAgentCreatedVisibilityFilter
    ? { includeRoutineExecutions: true, includeAgentCreatedTasks: state.showAgentCreatedTasks }
    : {};
}

export function applyIssueFilters(
  issues: Issue[],
  state: IssueFilterState,
  currentUserId?: string | null,
  enableAgentCreatedVisibilityFilter = false,
  liveIssueIds?: ReadonlySet<string>,
  workspaceContext: IssueFilterWorkspaceContext = {},
  now: Date = new Date(),
): Issue[] {
  let result = issues;
  const updatedRange = issueUpdatedTimeRange(state, now);
  if (updatedRange) {
    result = result.filter((issue) => {
      const time = new Date(issueUpdatedTime(issue)).getTime();
      if (!Number.isFinite(time)) return false;
      return (updatedRange.start == null || time >= updatedRange.start)
        && (updatedRange.end == null || time < updatedRange.end);
    });
  }
  if (state.liveOnly) {
    result = result.filter((issue) => liveIssueIds?.has(issue.id) === true);
  }
  if (state.routineTasksOnly) {
    result = result.filter((issue) => issue.originKind === "routine_execution");
  }
  if (enableAgentCreatedVisibilityFilter && !state.showAgentCreatedTasks && !state.routineTasksOnly) {
    result = result.filter((issue) => !isAgentCreatedIssue(issue));
  }
  if (state.statuses.length > 0) result = result.filter((issue) => state.statuses.includes(issue.displayStatus ?? issue.status));
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
  enableAgentCreatedVisibilityFilter = false,
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
  if (state.routineTasksOnly) count += 1;
  if (state.externalObjectStatuses.length > 0) count += 1;
  if (state.updatedWithin) count += 1;
  if (enableAgentCreatedVisibilityFilter && state.showAgentCreatedTasks) count += 1;
  return count;
}
