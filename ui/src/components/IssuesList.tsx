import { startTransition, useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import {
  shouldBlurPageSearchOnEnter,
  shouldBlurPageSearchOnEscape,
} from "../lib/keyboardShortcuts";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { buildCompanyUserLabelMap, buildCompanyUserProfileMap } from "../lib/company-members";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import {
  buildSubIssueProgressSummary,
  shouldRenderSubIssueProgressSummary,
  type SubIssueProgressSummary,
} from "../lib/issue-detail-subissues";
import { groupBy } from "../lib/groupBy";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  issueFilterLabel,
  issuePriorityOrder,
  normalizeIssueFilterState,
  resolveIssueFilterWorkspaceId,
  shouldIncludeIssueFilterWorkspaceOption,
  issueStatusOrder,
  type IssueFilterState,
} from "../lib/issue-filters";
import {
  DEFAULT_INBOX_ISSUE_COLUMNS,
  getAvailableInboxIssueColumns,
  normalizeInboxIssueColumns,
  resolveIssueWorkspaceName,
  type InboxIssueColumn,
} from "../lib/inbox";
import { cn } from "../lib/utils";
import {
  InboxIssueMetaLeading,
  InboxIssueTrailingColumns,
  IssueColumnPicker,
  issueActivityText,
  issueTrailingColumns,
} from "./IssueColumns";
import { StatusIcon } from "./StatusIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { IssueFiltersPopover } from "./IssueFiltersPopover";
import { IssueRow } from "./IssueRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, ArrowUpDown, Layers, Check, ChevronRight, List, ListTree, Columns3, User, Search, CircleSlash2 } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import { buildIssueTree, countDescendants } from "../lib/issue-tree";
import { buildSubIssueDefaultsForViewer } from "../lib/subIssueDefaults";
import { statusBadge } from "../lib/status-colors";
import { workflowSort } from "../lib/workflow-sort";
import { ISSUE_STATUSES, type Issue, type IssueStatus, type Project } from "@paperclipai/shared";
const ISSUE_SEARCH_DEBOUNCE_MS = 250;
const ISSUE_SEARCH_RESULT_LIMIT = 200;
const ISSUE_BOARD_COLUMN_RESULT_LIMIT = 200;
const INITIAL_ISSUE_ROW_RENDER_LIMIT = 100;
const ISSUE_ROW_RENDER_BATCH_SIZE = 150;
const ISSUE_ROW_RENDER_BATCH_DELAY_MS = 0;
const boardIssueStatuses = ISSUE_STATUSES;
const issueStatusLabels: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};
const progressSegmentClasses: Record<IssueStatus, string> = {
  backlog: "bg-muted-foreground/40",
  todo: "bg-blue-500",
  in_progress: "bg-yellow-500",
  in_review: "bg-violet-500",
  done: "bg-green-500",
  blocked: "bg-red-500",
  cancelled: "bg-neutral-400",
};

/* ── View state ── */

export type IssueSortField = "status" | "priority" | "title" | "created" | "updated" | "workflow";

export type IssueViewState = IssueFilterState & {
  sortField: IssueSortField;
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "workspace" | "parent" | "none";
  viewMode: "list" | "board";
  nestingEnabled: boolean;
  collapsedGroups: string[];
  collapsedParents: string[];
};

const defaultViewState: IssueViewState = {
  ...defaultIssueFilterState,
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  nestingEnabled: true,
  collapsedGroups: [],
  collapsedParents: [],
};

function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...defaultViewState, ...parsed, ...normalizeIssueFilterState(parsed) };
    }
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function getInitialViewState(
  key: string,
  initialAssignees?: string[],
  defaultSortField?: IssueSortField,
): IssueViewState {
  const hasStored = hasStoredViewState(key);
  const stored = getViewState(key);
  const base = !hasStored && defaultSortField
    ? { ...stored, sortField: defaultSortField, sortDir: "asc" as const }
    : stored;
  if (!initialAssignees) return base;
  return {
    ...base,
    assignees: initialAssignees,
    statuses: [],
  };
}

function getInitialWorkspaceViewState(
  key: string,
  initialAssignees?: string[],
  initialWorkspaces?: string[],
  defaultSortField?: IssueSortField,
): IssueViewState {
  const stored = getInitialViewState(key, initialAssignees, defaultSortField);
  if (!initialWorkspaces) return stored;
  return {
    ...stored,
    workspaces: initialWorkspaces,
    statuses: [],
  };
}

function hasStoredViewState(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function getIssueColumnsStorageKey(key: string): string {
  return `${key}:issue-columns`;
}

function loadIssueColumns(key: string): InboxIssueColumn[] {
  try {
    const raw = localStorage.getItem(getIssueColumnsStorageKey(key));
    if (raw === null) return DEFAULT_INBOX_ISSUE_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_ISSUE_COLUMNS;
    return normalizeInboxIssueColumns(parsed);
  } catch {
    return DEFAULT_INBOX_ISSUE_COLUMNS;
  }
}

function saveIssueColumns(key: string, columns: InboxIssueColumn[]) {
  try {
    localStorage.setItem(
      getIssueColumnsStorageKey(key),
      JSON.stringify(normalizeInboxIssueColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  if (state.sortField === "workflow") {
    const ordered = workflowSort(issues);
    return state.sortDir === "desc" ? [...ordered].reverse() : ordered;
  }
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (issueStatusOrder.indexOf(a.status) - issueStatusOrder.indexOf(b.status));
      case "priority":
        return dir * (issuePriorityOrder.indexOf(a.priority) - issuePriorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

function issueMatchesLocalSearch(issue: Issue, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;
  return [
    issue.identifier,
    issue.title,
    issue.description,
  ].some((value) => value?.toLowerCase().includes(normalizedSearch));
}

function isActionableWorkflowStatus(status: IssueStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function buildChecklistStepNumberMap(issues: Issue[], nestingEnabled: boolean): Map<string, string> {
  const stepNumberByIssueId = new Map<string, string>();

  if (!nestingEnabled) {
    issues.forEach((issue, index) => {
      stepNumberByIssueId.set(issue.id, String(index + 1));
    });
    return stepNumberByIssueId;
  }

  const { roots, childMap } = buildIssueTree(issues);
  const visit = (siblings: Issue[], prefix: string | null) => {
    siblings.forEach((issue, index) => {
      const stepNumber = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      stepNumberByIssueId.set(issue.id, stepNumber);
      visit(childMap.get(issue.id) ?? [], stepNumber);
    });
  };
  visit(roots, null);

  issues.forEach((issue, index) => {
    if (!stepNumberByIssueId.has(issue.id)) {
      stepNumberByIssueId.set(issue.id, String(index + 1));
    }
  });

  return stepNumberByIssueId;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

type CreatorOption = {
  id: string;
  label: string;
  kind: "agent" | "user";
  searchText?: string;
};

type ProjectOption = Pick<Project, "id" | "name"> & Partial<Pick<Project, "color" | "workspaces" | "executionWorkspacePolicy" | "primaryWorkspace">>;
type IssueListRequestFilters = NonNullable<Parameters<typeof issuesApi.list>[1]>;

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialWorkspaces?: string[];
  initialSearch?: string;
  searchFilters?: Omit<IssueListRequestFilters, "q" | "projectId" | "limit" | "includeRoutineExecutions">;
  searchWithinLoadedIssues?: boolean;
  baseCreateIssueDefaults?: Record<string, unknown>;
  createIssueLabel?: string;
  defaultSortField?: IssueSortField;
  showProgressSummary?: boolean;
  enableRoutineVisibilityFilter?: boolean;
  mutedIssueIds?: Set<string>;
  issueBadgeById?: Map<string, string>;
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

function IssueSearchInput({
  value,
  onDebouncedChange,
}: {
  value: string;
  onDebouncedChange?: (search: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    setDraftValue(value);
    lastCommittedValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!onDebouncedChange || draftValue === lastCommittedValueRef.current) return;

    const timeoutId = window.setTimeout(() => {
      lastCommittedValueRef.current = draftValue;
      startTransition(() => {
        onDebouncedChange(draftValue);
      });
    }, ISSUE_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [draftValue, onDebouncedChange]);

  return (
    <div className="relative w-48 sm:w-64 md:w-80">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={draftValue}
        onChange={(e) => {
          setDraftValue(e.target.value);
        }}
        onKeyDown={(e) => {
          if (shouldBlurPageSearchOnEnter({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
          })) {
            e.currentTarget.blur();
            return;
          }

          if (shouldBlurPageSearchOnEscape({
            key: e.key,
            isComposing: e.nativeEvent.isComposing,
            currentValue: e.currentTarget.value,
          })) {
            e.currentTarget.blur();
          }
        }}
        placeholder="Search issues..."
        className="pl-7 text-xs sm:text-sm"
        aria-label="Search issues"
        data-page-search-target="true"
      />
    </div>
  );
}

function SubIssueProgressSummaryStrip({
  summary,
  issueLinkState,
}: {
  summary: SubIssueProgressSummary;
  issueLinkState?: unknown;
}) {
  const target = summary.target;
  const targetIssue = target?.issue ?? null;
  const targetPathId = targetIssue?.identifier ?? targetIssue?.id ?? "";
  const targetState = targetIssue ? withIssueDetailHeaderSeed(issueLinkState, targetIssue) : undefined;
  const statusEntries = ISSUE_STATUSES
    .map((status) => ({ status, count: summary.countsByStatus[status] ?? 0 }))
    .filter((entry) => entry.count > 0);

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-medium text-foreground">
              {summary.doneCount}/{summary.totalCount} done
            </span>
            <span className="text-muted-foreground">
              {summary.inProgressCount} in progress
            </span>
            <span className="text-muted-foreground">
              {summary.blockedCount} blocked
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Sub-issues completion progress"
            aria-valuemin={0}
            aria-valuenow={summary.doneCount}
            aria-valuemax={summary.totalCount}
            className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            {statusEntries.map(({ status, count }) => (
              <span
                key={status}
                className={cn("h-full", progressSegmentClasses[status])}
                style={{ width: `${(count / summary.totalCount) * 100}%` }}
                title={`${issueStatusLabels[status]}: ${count}`}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm lg:w-72">
          {target && targetIssue ? (
            <>
              <div className="text-xs font-medium text-muted-foreground">
                {target.kind === "next" ? "Next up" : "Waiting on blockers"}
              </div>
              <Link
                to={createIssueDetailPath(targetPathId)}
                state={targetState}
                issuePrefetch={targetIssue}
                className="mt-1 block min-w-0 text-foreground underline-offset-2 hover:underline"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {targetIssue.identifier ?? targetIssue.id.slice(0, 8)}
                </span>{" "}
                <span>{targetIssue.title}</span>
              </Link>
            </>
          ) : summary.totalCount === 0 ? (
            <div className="text-sm font-medium text-foreground">No active sub-issues</div>
          ) : summary.doneCount === summary.totalCount ? (
            <div className="text-sm font-medium text-foreground">All sub-issues done</div>
          ) : (
            <div className="text-sm font-medium text-foreground">No actionable sub-issues</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialWorkspaces,
  initialSearch,
  searchFilters,
  searchWithinLoadedIssues = false,
  baseCreateIssueDefaults,
  createIssueLabel,
  defaultSortField,
  showProgressSummary = false,
  enableRoutineVisibilityFilter = false,
  mutedIssueIds,
  issueBadgeById,
  onSearchChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;
  const initialAssigneesKey = initialAssignees?.join("|") ?? "";
  const initialWorkspacesKey = initialWorkspaces?.join("|") ?? "";

  const [viewState, setViewState] = useState<IssueViewState>(() =>
    getInitialWorkspaceViewState(scopedKey, initialAssignees, initialWorkspaces, defaultSortField),
  );
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [renderedIssueRowLimit, setRenderedIssueRowLimit] = useState(INITIAL_ISSUE_ROW_RENDER_LIMIT);
  const [visibleIssueColumns, setVisibleIssueColumns] = useState<InboxIssueColumn[]>(() => loadIssueColumns(scopedKey));
  const deferredIssueSearch = useDeferredValue(issueSearch);
  const normalizedIssueSearch = deferredIssueSearch.trim().toLowerCase();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state whenever the persisted context changes.
  const prevViewStateContextKey = useRef(`${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`);
  useEffect(() => {
    const nextContextKey = `${scopedKey}::${initialAssigneesKey}::${initialWorkspacesKey}`;
    if (prevViewStateContextKey.current !== nextContextKey) {
      prevViewStateContextKey.current = nextContextKey;
      setViewState(getInitialWorkspaceViewState(scopedKey, initialAssignees, initialWorkspaces, defaultSortField));
    }
  }, [scopedKey, initialAssignees, initialAssigneesKey, initialWorkspaces, initialWorkspacesKey, defaultSortField]);

  const prevColumnsScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevColumnsScopedKey.current !== scopedKey) {
      prevColumnsScopedKey.current = scopedKey;
      setVisibleIssueColumns(loadIssueColumns(scopedKey));
    }
  }, [scopedKey]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      return next;
    });
  }, [scopedKey]);

  // Prune stale IDs from collapsedParents whenever the issue list changes.
  // Deleted or reassigned issues leave orphan IDs in localStorage; this keeps
  // the stored array bounded to only current parent IDs.
  useEffect(() => {
    const parentIds = new Set(issues.map((i) => i.parentId).filter(Boolean) as string[]);
    const pruned = viewState.collapsedParents.filter((id) => parentIds.has(id));
    if (pruned.length !== viewState.collapsedParents.length) {
      updateView({ collapsedParents: pruned });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: [
      ...queryKeys.issues.search(selectedCompanyId!, normalizedIssueSearch, projectId),
      searchFilters ?? {},
      ISSUE_SEARCH_RESULT_LIMIT,
      enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        q: normalizedIssueSearch,
        projectId,
        limit: ISSUE_SEARCH_RESULT_LIMIT,
        ...searchFilters,
        ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
      }),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0 && !searchWithinLoadedIssues,
    placeholderData: (previousData) => previousData,
  });
  const boardIssueQueries = useQueries({
    queries: boardIssueStatuses.map((status) => ({
      queryKey: [
        ...queryKeys.issues.list(selectedCompanyId ?? "__no-company__"),
        "board-column",
        status,
        normalizedIssueSearch,
        projectId ?? "__all-projects__",
        searchFilters ?? {},
        ISSUE_BOARD_COLUMN_RESULT_LIMIT,
        enableRoutineVisibilityFilter ? "with-routine-executions" : "without-routine-executions",
      ],
      queryFn: () =>
        issuesApi.list(selectedCompanyId!, {
          ...searchFilters,
          ...(normalizedIssueSearch.length > 0 ? { q: normalizedIssueSearch } : {}),
          projectId,
          status,
          limit: ISSUE_BOARD_COLUMN_RESULT_LIMIT,
          ...(enableRoutineVisibilityFilter ? { includeRoutineExecutions: true } : {}),
        }),
      enabled: !!selectedCompanyId && viewState.viewMode === "board" && !searchWithinLoadedIssues,
      placeholderData: (previousData: Issue[] | undefined) => previousData,
    })),
  });
  const { data: executionWorkspaces = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorkspaces.summaryList(selectedCompanyId)
      : ["execution-workspaces", "__disabled__"],
    queryFn: () => executionWorkspacesApi.listSummaries(selectedCompanyId!),
    enabled: !!selectedCompanyId && isolatedWorkspacesEnabled,
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const companyUserLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const companyUserProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );

  const projectById = useMemo(() => {
    const map = new Map<string, { name: string; color: string | null }>();
    for (const project of projects ?? []) {
      map.set(project.id, { name: project.name, color: project.color ?? null });
    }
    return map;
  }, [projects]);

  const projectWorkspaceById = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const project of projects ?? []) {
      for (const workspace of project.workspaces ?? []) {
        map.set(workspace.id, { name: workspace.name || project.name });
      }
    }
    return map;
  }, [projects]);

  const defaultProjectWorkspaceIdByProjectId = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      const defaultWorkspaceId =
        project.executionWorkspacePolicy?.defaultProjectWorkspaceId
        ?? project.primaryWorkspace?.id
        ?? null;
      if (defaultWorkspaceId) map.set(project.id, defaultWorkspaceId);
    }
    return map;
  }, [projects]);
  const defaultProjectWorkspaceIds = useMemo(
    () => new Set(defaultProjectWorkspaceIdByProjectId.values()),
    [defaultProjectWorkspaceIdByProjectId],
  );

  const executionWorkspaceById = useMemo(() => {
    const map = new Map<string, {
      name: string;
      mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
      projectWorkspaceId: string | null;
    }>();
    for (const workspace of executionWorkspaces) {
      map.set(workspace.id, {
        name: workspace.name,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId ?? null,
      });
    }
    return map;
  }, [executionWorkspaces]);
  const issueFilterWorkspaceContext = useMemo(() => ({
    executionWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }), [defaultProjectWorkspaceIdByProjectId, executionWorkspaceById]);

  const workspaceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [workspaceId, workspace] of projectWorkspaceById) {
      if (!shouldIncludeIssueFilterWorkspaceOption({ id: workspaceId }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    for (const [workspaceId, workspace] of executionWorkspaceById) {
      if (!shouldIncludeIssueFilterWorkspaceOption({
        id: workspaceId,
        mode: workspace.mode,
        projectWorkspaceId: workspace.projectWorkspaceId,
      }, defaultProjectWorkspaceIds)) continue;
      map.set(workspaceId, workspace.name);
    }
    return map;
  }, [defaultProjectWorkspaceIds, executionWorkspaceById, projectWorkspaceById]);

  const workspaceOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const [workspaceId, workspaceName] of workspaceNameMap) {
      options.set(workspaceId, workspaceName);
    }
    return [...options.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ id, name }));
  }, [workspaceNameMap]);

  const creatorOptions = useMemo<CreatorOption[]>(() => {
    const options = new Map<string, CreatorOption>();
    const knownAgentIds = new Set<string>();

    if (currentUserId) {
      options.set(`user:${currentUserId}`, {
        id: `user:${currentUserId}`,
        label: currentUserId === "local-board" ? "Board" : "Me",
        kind: "user",
        searchText: currentUserId === "local-board" ? "board me human local-board" : `me board human ${currentUserId}`,
      });
    }

    for (const issue of issues) {
      if (issue.createdByUserId) {
        const id = `user:${issue.createdByUserId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: formatAssigneeUserLabel(issue.createdByUserId, currentUserId) ?? issue.createdByUserId.slice(0, 5),
            kind: "user",
            searchText: `${issue.createdByUserId} board user human`,
          });
        }
      }
    }

    for (const agent of agents ?? []) {
      knownAgentIds.add(agent.id);
      const id = `agent:${agent.id}`;
      if (!options.has(id)) {
        options.set(id, {
          id,
          label: agent.name,
          kind: "agent",
          searchText: `${agent.name} ${agent.id} agent`,
        });
      }
    }

    for (const issue of issues) {
      if (issue.createdByAgentId && !knownAgentIds.has(issue.createdByAgentId)) {
        const id = `agent:${issue.createdByAgentId}`;
        if (!options.has(id)) {
          options.set(id, {
            id,
            label: issue.createdByAgentId.slice(0, 8),
            kind: "agent",
            searchText: `${issue.createdByAgentId} agent`,
          });
        }
      }
    }

    return [...options.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "user" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [agents, currentUserId, issues]);

  const visibleIssueColumnSet = useMemo(() => new Set(visibleIssueColumns), [visibleIssueColumns]);
  const availableIssueColumns = useMemo(
    () => getAvailableInboxIssueColumns(isolatedWorkspacesEnabled),
    [isolatedWorkspacesEnabled],
  );
  const availableIssueColumnSet = useMemo(() => new Set(availableIssueColumns), [availableIssueColumns]);
  const visibleTrailingIssueColumns = useMemo(
    () => issueTrailingColumns.filter((column) => visibleIssueColumnSet.has(column) && availableIssueColumnSet.has(column)),
    [availableIssueColumnSet, visibleIssueColumnSet],
  );

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const issueTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of issues) {
      map.set(issue.id, issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title);
    }
    return map;
  }, [issues]);

  const boardIssues = useMemo(() => {
    if (viewState.viewMode !== "board" || searchWithinLoadedIssues) return null;
    const merged = new Map<string, Issue>();
    let isPending = false;
    for (const query of boardIssueQueries) {
      isPending ||= query.isPending;
      for (const issue of query.data ?? []) {
        merged.set(issue.id, issue);
      }
    }
    if (merged.size > 0) return [...merged.values()];
    return isPending ? issues : [];
  }, [boardIssueQueries, issues, searchWithinLoadedIssues, viewState.viewMode]);
  const boardColumnLimitReached = useMemo(
    () =>
      viewState.viewMode === "board" &&
      !searchWithinLoadedIssues &&
      boardIssueQueries.some((query) => (query.data?.length ?? 0) === ISSUE_BOARD_COLUMN_RESULT_LIMIT),
    [boardIssueQueries, searchWithinLoadedIssues, viewState.viewMode],
  );

  const filtered = useMemo(() => {
    const useRemoteSearch = normalizedIssueSearch.length > 0 && !searchWithinLoadedIssues;
    const sourceIssues = boardIssues ?? (useRemoteSearch ? searchedIssues : issues);
    const searchScopedIssues = normalizedIssueSearch.length > 0 && searchWithinLoadedIssues
      ? sourceIssues.filter((issue) => issueMatchesLocalSearch(issue, normalizedIssueSearch))
      : sourceIssues;
    const filteredByControls = applyIssueFilters(
      searchScopedIssues,
      viewState,
      currentUserId,
      enableRoutineVisibilityFilter,
      liveIssueIds,
      issueFilterWorkspaceContext,
    );
    return sortIssues(filteredByControls, viewState);
  }, [
    boardIssues,
    issues,
    searchedIssues,
    searchWithinLoadedIssues,
    viewState,
    normalizedIssueSearch,
    currentUserId,
    enableRoutineVisibilityFilter,
    liveIssueIds,
    issueFilterWorkspaceContext,
  ]);

  const progressSummary = useMemo(
    () => shouldRenderSubIssueProgressSummary(showProgressSummary, issues.length)
      ? buildSubIssueProgressSummary(issues)
      : null,
    [issues, showProgressSummary],
  );
  const checklistAffordanceEnabled = useMemo(
    () =>
      defaultSortField === "workflow"
      && viewState.groupBy === "none",
    [defaultSortField, viewState.groupBy],
  );
  const workflowChecklistMeta = useMemo(() => {
    if (!checklistAffordanceEnabled) return null;

    const visibleIssueIds = new Set(filtered.map((issue) => issue.id));
    const stepNumberByIssueId = buildChecklistStepNumberMap(filtered, viewState.nestingEnabled);
    const unresolvedVisibleBlockersByIssueId = new Map<string, string[]>();

    filtered.forEach((issue) => {
      const unresolvedVisible = (issue.blockedBy ?? [])
        .map((blocker) => blocker.id)
        .filter((blockerId) => {
          if (!visibleIssueIds.has(blockerId)) return false;
          const blockerIssue = issueById.get(blockerId);
          if (!blockerIssue) return false;
          return blockerIssue.status !== "done" && blockerIssue.status !== "cancelled";
        });
      unresolvedVisibleBlockersByIssueId.set(issue.id, unresolvedVisible);
    });

    const firstActionable = filtered.find((issue) => isActionableWorkflowStatus(issue.status)) ?? null;
    const currentStepIssue = firstActionable ?? filtered.find((issue) => issue.status === "blocked") ?? null;

    return {
      stepNumberByIssueId,
      unresolvedVisibleBlockersByIssueId,
      currentStepIssueId: currentStepIssue?.id ?? null,
    };
  }, [checklistAffordanceEnabled, filtered, issueById, viewState.nestingEnabled]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveIssueFilters(viewState, enableRoutineVisibilityFilter);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return issueStatusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: issueFilterLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return issuePriorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: issueFilterLabel(p), items: groups[p]! }));
    }
    if (viewState.groupBy === "workspace") {
      const groups = groupBy(
        filtered,
        (issue) => resolveIssueFilterWorkspaceId(issue, issueFilterWorkspaceContext) ?? "__no_workspace",
      );
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no workspace" last
          if (a === "__no_workspace") return 1;
          if (b === "__no_workspace") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label: key === "__no_workspace" ? "No Workspace" : (workspaceNameMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    if (viewState.groupBy === "parent") {
      const groups = groupBy(filtered, (i) => i.parentId ?? "__no_parent");
      return Object.keys(groups)
        .sort((a, b) => {
          // Groups with items first, "no parent" last
          if (a === "__no_parent") return 1;
          if (b === "__no_parent") return -1;
          return (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0);
        })
        .map((key) => ({
          key,
          label: key === "__no_parent" ? "No Parent" : (issueTitleMap.get(key) ?? key.slice(0, 8)),
          items: groups[key]!,
        }));
    }
    // assignee
    const groups = groupBy(
      filtered,
      (issue) => issue.assigneeAgentId ?? (issue.assigneeUserId ? `__user:${issue.assigneeUserId}` : "__unassigned"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__unassigned"
          ? "Unassigned"
          : key.startsWith("__user:")
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId, companyUserLabelMap) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [
    filtered,
    issueFilterWorkspaceContext,
    viewState.groupBy,
    agents,
    agentName,
    currentUserId,
    workspaceNameMap,
    issueTitleMap,
    companyUserLabelMap,
  ]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    setRenderedIssueRowLimit(Math.min(filtered.length, INITIAL_ISSUE_ROW_RENDER_LIMIT));
  }, [filtered, viewState.viewMode]);

  useEffect(() => {
    if (viewState.viewMode !== "list") return;
    if (renderedIssueRowLimit >= filtered.length) return;

    const timeoutId = window.setTimeout(() => {
      startTransition(() => {
        setRenderedIssueRowLimit((current) => Math.min(filtered.length, current + ISSUE_ROW_RENDER_BATCH_SIZE));
      });
    }, ISSUE_ROW_RENDER_BATCH_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [filtered.length, renderedIssueRowLimit, viewState.viewMode]);

  const remainingIssueRowCount = Math.max(filtered.length - renderedIssueRowLimit, 0);

  const newIssueDefaults = useCallback((groupKey?: string) => {
    const defaults: Record<string, unknown> = { ...(baseCreateIssueDefaults ?? {}) };
    if (projectId && defaults.projectId === undefined) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
      else if (viewState.groupBy === "parent" && groupKey !== "__no_parent") {
        const parentIssue = issueById.get(groupKey);
        if (parentIssue) Object.assign(defaults, buildSubIssueDefaultsForViewer(parentIssue, currentUserId));
        else defaults.parentId = groupKey;
      }
    }
    return defaults;
  }, [baseCreateIssueDefaults, currentUserId, issueById, projectId, viewState.groupBy]);

  const createActionLabel = createIssueLabel ? `Create ${createIssueLabel}` : "Create Issue";
  const createButtonLabel = createIssueLabel ? `New ${createIssueLabel}` : "New Issue";
  const openCreateIssueDialog = useCallback((groupKey?: string) => {
    openNewIssue(newIssueDefaults(groupKey));
  }, [newIssueDefaults, openNewIssue]);

  const filterToWorkspace = useCallback((workspaceId: string) => {
    updateView({ workspaces: [workspaceId] });
  }, [updateView]);

  const setIssueColumns = useCallback((next: InboxIssueColumn[]) => {
    const normalized = normalizeInboxIssueColumns(next);
    setVisibleIssueColumns(normalized);
    saveIssueColumns(scopedKey, normalized);
  }, [scopedKey]);

  const toggleIssueColumn = useCallback((column: InboxIssueColumn, enabled: boolean) => {
    if (enabled) {
      setIssueColumns([...visibleIssueColumns, column]);
      return;
    }
    setIssueColumns(visibleIssueColumns.filter((value) => value !== column));
  }, [setIssueColumns, visibleIssueColumns]);

  const assignIssue = useCallback((issueId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  }, [onUpdateIssue]);

  let remainingRowsToRender = viewState.viewMode === "list" ? renderedIssueRowLimit : Number.POSITIVE_INFINITY;

  return (
    <div className="space-y-4">
      {progressSummary ? (
        <SubIssueProgressSummaryStrip summary={progressSummary} issueLinkState={issueLinkState} />
      ) : null}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openCreateIssueDialog()}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{createButtonLabel}</span>
          </Button>
          <IssueSearchInput
            value={issueSearch}
            onDebouncedChange={(nextSearch) => {
              setIssueSearch(nextSearch);
              onSearchChange?.(nextSearch);
            }}
          />
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden mr-1">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {viewState.viewMode === "list" && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className={cn("hidden h-8 w-8 shrink-0 sm:inline-flex", viewState.nestingEnabled && "bg-accent")}
              onClick={() => updateView({ nestingEnabled: !viewState.nestingEnabled })}
              title={viewState.nestingEnabled ? "Disable parent-child nesting" : "Enable parent-child nesting"}
            >
              <ListTree className="h-3.5 w-3.5" />
            </Button>
          )}

          <IssueColumnPicker
            availableColumns={availableIssueColumns}
            visibleColumnSet={visibleIssueColumnSet}
            onToggleColumn={toggleIssueColumn}
            onResetColumns={() => setIssueColumns(DEFAULT_INBOX_ISSUE_COLUMNS)}
            title="Choose which issue columns stay visible"
            iconOnly
          />

          <IssueFiltersPopover
            state={viewState}
            onChange={updateView}
            activeFilterCount={activeFilterCount}
            agents={agents}
            creators={creatorOptions}
            projects={projects?.map((project) => ({ id: project.id, name: project.name }))}
            labels={labels?.map((label) => ({ id: label.id, name: label.name, color: label.color }))}
            currentUserId={currentUserId}
            enableRoutineVisibilityFilter={enableRoutineVisibilityFilter}
            iconOnly
            workspaces={isolatedWorkspacesEnabled ? workspaceOptions : undefined}
          />

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Sort">
                  <ArrowUpDown className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["workflow", "Workflow"],
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="Group">
                  <Layers className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["workspace", "Workspace"],
                    ["parent", "Parent Issue"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {!searchWithinLoadedIssues && normalizedIssueSearch.length > 0 && searchedIssues.length === ISSUE_SEARCH_RESULT_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Showing up to {ISSUE_SEARCH_RESULT_LIMIT} matches. Refine the search to narrow further.
        </p>
      )}
      {boardColumnLimitReached && (
        <p className="text-xs text-muted-foreground">
          Some board columns are showing up to {ISSUE_BOARD_COLUMN_RESULT_LIMIT} issues. Refine filters or search to reveal the rest.
        </p>
      )}
      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <EmptyState
          icon={CircleDot}
          message="No issues match the current filters or search."
          action={createActionLabel}
          onAction={() => openCreateIssueDialog()}
        />
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
          onUpdateIssue={onUpdateIssue}
        />
      ) : (
        <>
          {groupedContent.map((group) => {
          if (remainingRowsToRender <= 0) return null;
          return (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <IssueGroupHeader
                label={group.label}
                collapsible
                collapsed={viewState.collapsedGroups.includes(group.key)}
                onToggle={() => {
                  updateView({
                    collapsedGroups: viewState.collapsedGroups.includes(group.key)
                      ? viewState.collapsedGroups.filter((k) => k !== group.key)
                      : [...viewState.collapsedGroups, group.key],
                  });
                }}
                trailing={(
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    onClick={() => openCreateIssueDialog(group.key)}
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                )}
              />
            )}
            <CollapsibleContent>
              {(() => {
                const { roots, childMap } = viewState.nestingEnabled
                  ? buildIssueTree(group.items)
                  : { roots: group.items, childMap: new Map<string, Issue[]>() };

                const renderIssueRow = (issue: Issue, depth: number) => {
                  if (remainingRowsToRender <= 0) return null;
                  remainingRowsToRender -= 1;

                  const children = childMap.get(issue.id) ?? [];
                  const hasChildren = children.length > 0;
                  const totalDescendants = hasChildren ? countDescendants(issue.id, childMap) : 0;
                  const isExpanded = !viewState.collapsedParents.includes(issue.id);
                  const useDeferredRowRendering = !(hasChildren && isExpanded);
                  const issueProject = issue.projectId ? projectById.get(issue.projectId) ?? null : null;
                  const parentIssue = issue.parentId ? issueById.get(issue.parentId) ?? null : null;
                  const issueBadge = issueBadgeById?.get(issue.id);
                  const isMutedIssue = mutedIssueIds?.has(issue.id) === true;
                  const assigneeUserProfile = issue.assigneeUserId
                    ? companyUserProfileMap.get(issue.assigneeUserId) ?? null
                    : null;
                  const assigneeUserLabel = formatAssigneeUserLabel(
                    issue.assigneeUserId,
                    currentUserId,
                    companyUserLabelMap,
                  ) ?? assigneeUserProfile?.label ?? null;
                  const toggleCollapse = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
                    e.preventDefault();
                    e.stopPropagation();
                    updateView({
                      collapsedParents: isExpanded
                        ? [...viewState.collapsedParents, issue.id]
                        : viewState.collapsedParents.filter((id) => id !== issue.id),
                    });
                  };
                  const checklistMeta = workflowChecklistMeta;
                  const checklistStepNumber = checklistMeta?.stepNumberByIssueId.get(issue.id) ?? null;
                  const unresolvedVisibleBlockers = checklistMeta?.unresolvedVisibleBlockersByIssueId.get(issue.id) ?? [];
                  const checklistRowId = checklistMeta ? `issue-workflow-row-${issue.id}` : undefined;
                  const doneRowTitleClass = checklistMeta && issue.status === "done"
                    ? "text-muted-foreground"
                    : undefined;
                  const checklistDependencyChips = checklistMeta && unresolvedVisibleBlockers.length > 0 ? (
                    <>
                      {unresolvedVisibleBlockers.map((blockerId) => {
                        const blockerIssue = issueById.get(blockerId);
                        if (!blockerIssue) return null;
                        const label = blockerIssue.identifier ?? blockerIssue.id.slice(0, 8);
                        const blockerStep = checklistMeta.stepNumberByIssueId.get(blockerId);
                        const blockerStepSuffix = blockerStep ? ` \u00b7 step ${blockerStep}` : "";
                        const chipLabel = `blocked by ${label}${blockerStepSuffix}`;
                        return (
                          <button
                            key={blockerId}
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              const target = document.getElementById(`issue-workflow-row-${blockerId}`);
                              if (!target) return;
                              target.scrollIntoView({ behavior: "smooth", block: "nearest" });
                              target.focus?.();
                            }}
                            className="inline-flex items-center rounded-full border border-amber-400/45 bg-amber-50/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100/80 dark:border-amber-300/35 dark:bg-amber-400/10 dark:text-amber-300"
                            title={chipLabel}
                            aria-label={chipLabel}
                          >
                            {chipLabel}
                          </button>
                        );
                      })}
                    </>
                  ) : null;

                  return (
                    <div
                      key={issue.id}
                      style={{
                        ...(depth > 0 ? { paddingLeft: `${depth * 16}px` } : {}),
                        ...(useDeferredRowRendering
                          ? {
                            contentVisibility: "auto",
                            containIntrinsicSize: "44px",
                          }
                          : {}),
                      }}
                    >
                      <IssueRow
                        issue={issue}
                        issueLinkState={issueLinkState}
                        checklistStepNumber={checklistStepNumber}
                        checklistCurrentStep={checklistMeta?.currentStepIssueId === issue.id}
                        checklistDependencyChips={checklistDependencyChips}
                        checklistRowId={checklistRowId}
                        titleClassName={doneRowTitleClass}
                        titleSuffix={(
                          <>
                            {hasChildren && !isExpanded ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                ({totalDescendants} sub-task{totalDescendants !== 1 ? "s" : ""})
                              </span>
                            ) : null}
                            {issueBadge ? (
                              issueBadge === "Paused" ? (
                                <span
                                  className={cn("ml-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", statusBadge.paused)}
                                  aria-label="Paused"
                                  title="Paused"
                                >
                                  <CircleSlash2 className="h-3 w-3" />
                                  Paused
                                </span>
                              ) : (
                                <span className="ml-1.5 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                  {issueBadge}
                                </span>
                              )
                            ) : null}
                          </>
                        )}
                        className={isMutedIssue ? "opacity-70" : undefined}
                        mobileLeading={
                          hasChildren ? (
                            <button type="button" onClick={toggleCollapse}>
                              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                            </button>
                          ) : (
                            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                              <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
                            </span>
                          )
                        }
                        desktopMetaLeading={(
                          <>
                            {hasChildren ? (
                              <button
                                type="button"
                                className="hidden shrink-0 items-center sm:inline-flex"
                                onClick={toggleCollapse}
                              >
                                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                              </button>
                            ) : (
                              <span className="hidden w-3.5 shrink-0 sm:block" />
                            )}
                            <InboxIssueMetaLeading
                              issue={issue}
                              isLive={liveIssueIds?.has(issue.id) === true}
                              showStatus={visibleIssueColumnSet.has("status") && availableIssueColumnSet.has("status")}
                              showIdentifier={visibleIssueColumnSet.has("id") && availableIssueColumnSet.has("id")}
                              checklistStepNumber={checklistStepNumber}
                              statusSlot={(
                                <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                                  <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
                                </span>
                              )}
                            />
                          </>
                        )}
                        mobileMeta={issueActivityText(issue).toLowerCase()}
                        desktopTrailing={(
                          visibleTrailingIssueColumns.length > 0 ? (
                            <InboxIssueTrailingColumns
                              issue={issue}
                              columns={visibleTrailingIssueColumns}
                              projectName={issueProject?.name ?? null}
                              projectColor={issueProject?.color ?? null}
                              workspaceId={resolveIssueFilterWorkspaceId(issue, issueFilterWorkspaceContext)}
                              workspaceName={resolveIssueWorkspaceName(issue, {
                                executionWorkspaceById,
                                projectWorkspaceById,
                                defaultProjectWorkspaceIdByProjectId,
                              })}
                              onFilterWorkspace={filterToWorkspace}
                              assigneeName={agentName(issue.assigneeAgentId)}
                              assigneeUserName={assigneeUserLabel}
                              assigneeUserAvatarUrl={assigneeUserProfile?.image ?? null}
                              currentUserId={currentUserId}
                              parentIdentifier={parentIssue?.identifier ?? null}
                              parentTitle={parentIssue?.title ?? null}
                              assigneeContent={(
                                <Popover
                                  open={assigneePickerIssueId === issue.id}
                                  onOpenChange={(open) => {
                                    setAssigneePickerIssueId(open ? issue.id : null);
                                    if (!open) setAssigneeSearch("");
                                  }}
                                >
                                  <PopoverTrigger asChild>
                                    <button
                                      className="flex w-full shrink-0 items-center overflow-hidden rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
                                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                    >
                                      {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                                        <Identity name={agentName(issue.assigneeAgentId)!} size="sm" className="min-w-0" />
                                      ) : issue.assigneeUserId ? (
                                        <Identity
                                          name={assigneeUserLabel ?? "User"}
                                          avatarUrl={assigneeUserProfile?.image ?? null}
                                          size="sm"
                                          className="min-w-0"
                                        />
                                      ) : (
                                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                            <User className="h-3.5 w-3.5" />
                                          </span>
                                          Assignee
                                        </span>
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    className="w-56 p-1"
                                    align="end"
                                    onClick={(e) => e.stopPropagation()}
                                    onPointerDownOutside={() => setAssigneeSearch("")}
                                  >
                                    <input
                                      className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
                                      placeholder="Search assignees..."
                                      value={assigneeSearch}
                                      onChange={(e) => setAssigneeSearch(e.target.value)}
                                      autoFocus
                                    />
                                    <div className="max-h-48 overflow-y-auto overscroll-contain">
                                      <button
                                        className={cn(
                                          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                                          !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent",
                                        )}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          assignIssue(issue.id, null, null);
                                        }}
                                      >
                                        No assignee
                                      </button>
                                      {currentUserId && (
                                        <button
                                          className={cn(
                                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                            issue.assigneeUserId === currentUserId && "bg-accent",
                                          )}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            assignIssue(issue.id, null, currentUserId);
                                          }}
                                        >
                                          <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                          <span>Me</span>
                                        </button>
                                      )}
                                      {(agents ?? [])
                                        .filter((agent) => {
                                          if (!assigneeSearch.trim()) return true;
                                          return agent.name.toLowerCase().includes(assigneeSearch.toLowerCase());
                                        })
                                        .map((agent) => (
                                          <button
                                            key={agent.id}
                                            className={cn(
                                              "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                              issue.assigneeAgentId === agent.id && "bg-accent",
                                            )}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              assignIssue(issue.id, agent.id, null);
                                            }}
                                          >
                                            <Identity name={agent.name} size="sm" className="min-w-0" />
                                          </button>
                                        ))}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                            />
                          ) : undefined
                        )}
                      />
                      {hasChildren && isExpanded && children.map((child) => renderIssueRow(child, depth + 1))}
                    </div>
                  );
                };

                return roots.map((issue) => renderIssueRow(issue, 0)).filter((node) => node !== null);
              })()}
            </CollapsibleContent>
          </Collapsible>
          );
          })}
          {remainingIssueRowCount > 0 && (
            <p className="text-xs text-muted-foreground">
              Rendering {Math.min(renderedIssueRowLimit, filtered.length)} of {filtered.length} issues
            </p>
          )}
        </>
      )}
    </div>
  );
}
