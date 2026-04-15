import type {
  Approval,
  DashboardSummary,
  HeartbeatRun,
  InboxDismissal,
  Issue,
  JoinRequest,
} from "@paperclipai/shared";
import {
  applyIssueFilters,
  defaultIssueFilterState,
  type IssueFilterState,
} from "./issue-filters";

export const RECENT_ISSUES_LIMIT = 100;
export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
export const DISMISSED_KEY = "paperclip:inbox:dismissed";
export const READ_ITEMS_KEY = "paperclip:inbox:read-items";
export const INBOX_LAST_TAB_KEY = "paperclip:inbox:last-tab";
export const INBOX_ISSUE_COLUMNS_KEY = "paperclip:inbox:issue-columns";
export const INBOX_NESTING_KEY = "paperclip:inbox:nesting";
export const INBOX_GROUP_BY_KEY = "paperclip:inbox:group-by";
export const INBOX_FILTER_PREFERENCES_KEY_PREFIX = "paperclip:inbox:filters";
export const INBOX_COLLAPSED_GROUPS_KEY_PREFIX = "paperclip:inbox:collapsed-groups";
export type InboxTab = "mine" | "recent" | "unread" | "all";
export type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
export type InboxApprovalFilter = "all" | "actionable" | "resolved";
export type InboxWorkItemGroupBy = "none" | "type" | "workspace";
export const inboxIssueColumns = [
  "status",
  "id",
  "assignee",
  "project",
  "workspace",
  "parent",
  "labels",
  "updated",
] as const;
export type InboxIssueColumn = (typeof inboxIssueColumns)[number];
export const DEFAULT_INBOX_ISSUE_COLUMNS: InboxIssueColumn[] = ["status", "id", "updated"];
export interface InboxFilterPreferences {
  allCategoryFilter: InboxCategoryFilter;
  allApprovalFilter: InboxApprovalFilter;
  issueFilters: IssueFilterState;
}
export type InboxWorkItem =
  | {
      kind: "issue";
      timestamp: number;
      issue: Issue;
    }
  | {
      kind: "approval";
      timestamp: number;
      approval: Approval;
    }
  | {
      kind: "failed_run";
      timestamp: number;
      run: HeartbeatRun;
    }
  | {
      kind: "join_request";
      timestamp: number;
      joinRequest: JoinRequest;
    };

export interface InboxBadgeData {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  mineIssues: number;
  alerts: number;
}

export interface InboxWorkItemGroup {
  key: string;
  label: string | null;
  items: InboxWorkItem[];
}

export interface InboxKeyboardGroupSection {
  key: string;
  displayItems: InboxWorkItem[];
  childrenByIssueId: ReadonlyMap<string, Issue[]>;
}

export type InboxKeyboardNavEntry =
  | {
      type: "top";
      itemKey: string;
      item: InboxWorkItem;
    }
  | {
      type: "child";
      issueId: string;
      issue: Issue;
    };

export interface InboxProjectWorkspaceLookup {
  name: string;
}

export interface InboxExecutionWorkspaceLookup {
  name: string;
  mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
  projectWorkspaceId: string | null;
}

export interface InboxWorkspaceGroupingOptions {
  executionWorkspaceById?: ReadonlyMap<string, InboxExecutionWorkspaceLookup>;
  projectWorkspaceById?: ReadonlyMap<string, InboxProjectWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
}

const defaultInboxFilterPreferences: InboxFilterPreferences = {
  allCategoryFilter: "everything",
  allApprovalFilter: "all",
  issueFilters: defaultIssueFilterState,
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeIssueFilterState(value: unknown): IssueFilterState {
  if (!value || typeof value !== "object") return { ...defaultIssueFilterState };
  const candidate = value as Partial<Record<keyof IssueFilterState, unknown>>;
  return {
    statuses: normalizeStringArray(candidate.statuses),
    priorities: normalizeStringArray(candidate.priorities),
    assignees: normalizeStringArray(candidate.assignees),
    labels: normalizeStringArray(candidate.labels),
    projects: normalizeStringArray(candidate.projects),
    workspaces: normalizeStringArray(candidate.workspaces),
    showRoutineExecutions: candidate.showRoutineExecutions === true,
  };
}

function normalizeInboxCategoryFilter(value: unknown): InboxCategoryFilter {
  return value === "issues_i_touched"
    || value === "join_requests"
    || value === "approvals"
    || value === "failed_runs"
    || value === "alerts"
    ? value
    : "everything";
}

function normalizeInboxApprovalFilter(value: unknown): InboxApprovalFilter {
  return value === "actionable" || value === "resolved" ? value : "all";
}

function getInboxFilterPreferencesStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${INBOX_FILTER_PREFERENCES_KEY_PREFIX}:${companyId}`;
}

function getInboxCollapsedGroupsStorageKey(companyId: string | null | undefined): string | null {
  if (!companyId) return null;
  return `${INBOX_COLLAPSED_GROUPS_KEY_PREFIX}:${companyId}`;
}

export function loadInboxFilterPreferences(
  companyId: string | null | undefined,
): InboxFilterPreferences {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) {
    return {
      ...defaultInboxFilterPreferences,
      issueFilters: { ...defaultIssueFilterState },
    };
  }

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return {
        ...defaultInboxFilterPreferences,
        issueFilters: { ...defaultIssueFilterState },
      };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      allCategoryFilter: normalizeInboxCategoryFilter(parsed.allCategoryFilter),
      allApprovalFilter: normalizeInboxApprovalFilter(parsed.allApprovalFilter),
      issueFilters: normalizeIssueFilterState(parsed.issueFilters),
    };
  } catch {
    return {
      ...defaultInboxFilterPreferences,
      issueFilters: { ...defaultIssueFilterState },
    };
  }
}

export function saveInboxFilterPreferences(
  companyId: string | null | undefined,
  preferences: InboxFilterPreferences,
) {
  const storageKey = getInboxFilterPreferencesStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        allCategoryFilter: normalizeInboxCategoryFilter(preferences.allCategoryFilter),
        allApprovalFilter: normalizeInboxApprovalFilter(preferences.allApprovalFilter),
        issueFilters: normalizeIssueFilterState(preferences.issueFilters),
      }),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
): Set<string> {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return new Set();

  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(normalizeStringArray(parsed));
  } catch {
    return new Set();
  }
}

export function saveCollapsedInboxGroupKeys(
  companyId: string | null | undefined,
  groupKeys: ReadonlySet<string>,
) {
  const storageKey = getInboxCollapsedGroupsStorageKey(companyId);
  if (!storageKey) return;

  try {
    localStorage.setItem(storageKey, JSON.stringify([...groupKeys]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadDismissedInboxAlerts(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.startsWith("alert:")));
  } catch {
    return new Set();
  }
}

export function saveDismissedInboxAlerts(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function buildInboxDismissedAtByKey(dismissals: InboxDismissal[]): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [dismissal.itemKey, normalizeTimestamp(dismissal.dismissedAt)]),
  );
}

export function isInboxEntityDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: string | Date | null | undefined,
): boolean {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function loadReadInboxItems(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_ITEMS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

export function saveReadInboxItems(ids: Set<string>) {
  try {
    localStorage.setItem(READ_ITEMS_KEY, JSON.stringify([...ids]));
  } catch {
    // Ignore localStorage failures.
  }
}

export function normalizeInboxIssueColumns(columns: Iterable<string | InboxIssueColumn>): InboxIssueColumn[] {
  const selected = new Set(columns);
  return inboxIssueColumns.filter((column) => selected.has(column));
}

export function getAvailableInboxIssueColumns(enableWorkspaceColumn: boolean): InboxIssueColumn[] {
  if (enableWorkspaceColumn) return [...inboxIssueColumns];
  return inboxIssueColumns.filter((column) => column !== "workspace");
}

export function loadInboxIssueColumns(): InboxIssueColumn[] {
  try {
    const raw = localStorage.getItem(INBOX_ISSUE_COLUMNS_KEY);
    if (raw === null) return DEFAULT_INBOX_ISSUE_COLUMNS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_INBOX_ISSUE_COLUMNS;
    return normalizeInboxIssueColumns(parsed);
  } catch {
    return DEFAULT_INBOX_ISSUE_COLUMNS;
  }
}

export function saveInboxIssueColumns(columns: InboxIssueColumn[]) {
  try {
    localStorage.setItem(
      INBOX_ISSUE_COLUMNS_KEY,
      JSON.stringify(normalizeInboxIssueColumns(columns)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

export function loadInboxWorkItemGroupBy(): InboxWorkItemGroupBy {
  try {
    const raw = localStorage.getItem(INBOX_GROUP_BY_KEY);
    return raw === "type" || raw === "workspace" ? raw : "none";
  } catch {
    return "none";
  }
}

export function saveInboxWorkItemGroupBy(groupBy: InboxWorkItemGroupBy) {
  try {
    localStorage.setItem(INBOX_GROUP_BY_KEY, groupBy);
  } catch {
    // Ignore localStorage failures.
  }
}

export function shouldResetInboxWorkspaceGrouping(
  groupBy: InboxWorkItemGroupBy,
  isolatedWorkspacesEnabled: boolean,
  experimentalSettingsLoaded: boolean,
): boolean {
  return experimentalSettingsLoaded && groupBy === "workspace" && !isolatedWorkspacesEnabled;
}

export function shouldIncludeRoutineExecutionIssue(
  issue: Pick<Issue, "originKind">,
  showRoutineExecutions: boolean,
): boolean {
  return showRoutineExecutions || issue.originKind !== "routine_execution";
}

export function filterInboxIssues(issues: Issue[], showRoutineExecutions: boolean): Issue[] {
  if (showRoutineExecutions) return issues;
  return issues.filter((issue) => shouldIncludeRoutineExecutionIssue(issue, showRoutineExecutions));
}

export function matchesInboxIssueSearch(
  issue: Pick<Issue, "title" | "identifier" | "description" | "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  query: string,
  {
    isolatedWorkspacesEnabled = false,
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions & {
    isolatedWorkspacesEnabled?: boolean;
  } = {},
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  if (issue.title.toLowerCase().includes(normalizedQuery)) return true;
  if (issue.identifier?.toLowerCase().includes(normalizedQuery)) return true;
  if (issue.description?.toLowerCase().includes(normalizedQuery)) return true;
  if (!isolatedWorkspacesEnabled) return false;

  const workspaceName = resolveIssueWorkspaceName(issue, {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  });
  return workspaceName?.toLowerCase().includes(normalizedQuery) ?? false;
}

export function getArchivedInboxSearchIssues({
  visibleIssues,
  searchableIssues,
  query,
  isolatedWorkspacesEnabled = false,
  executionWorkspaceById,
  projectWorkspaceById,
  defaultProjectWorkspaceIdByProjectId,
}: {
  visibleIssues: Issue[];
  searchableIssues: Issue[];
  query: string;
  isolatedWorkspacesEnabled?: boolean;
  executionWorkspaceById?: ReadonlyMap<string, InboxExecutionWorkspaceLookup>;
  projectWorkspaceById?: ReadonlyMap<string, InboxProjectWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
}): Issue[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const visibleIssueIds = new Set(visibleIssues.map((issue) => issue.id));
  return searchableIssues
    .filter((issue) => !visibleIssueIds.has(issue.id))
    .filter((issue) =>
      matchesInboxIssueSearch(issue, normalizedQuery, {
        isolatedWorkspacesEnabled,
        executionWorkspaceById,
        projectWorkspaceById,
        defaultProjectWorkspaceIdByProjectId,
      }),
    )
    .sort(sortIssuesByMostRecentActivity);
}

export function getInboxSearchSupplementIssues({
  query,
  filteredWorkItems,
  archivedSearchIssues,
  remoteIssues,
  issueFilters,
  currentUserId,
  enableRoutineVisibilityFilter = false,
}: {
  query: string;
  filteredWorkItems: InboxWorkItem[];
  archivedSearchIssues: Issue[];
  remoteIssues: Issue[];
  issueFilters: IssueFilterState;
  currentUserId?: string | null;
  enableRoutineVisibilityFilter?: boolean;
}): Issue[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const visibleIssueIds = new Set([
    ...filteredWorkItems
      .filter((item): item is Extract<InboxWorkItem, { kind: "issue" }> => item.kind === "issue")
      .map((item) => item.issue.id),
    ...archivedSearchIssues.map((issue) => issue.id),
  ]);
  return applyIssueFilters(remoteIssues, issueFilters, currentUserId, enableRoutineVisibilityFilter)
    .filter((issue) => !visibleIssueIds.has(issue.id));
}

function formatDefaultWorkspaceGroupLabel(name: string | null | undefined): string {
  const normalizedName = name?.trim();
  return normalizedName ? `${normalizedName} (default)` : "Default workspace";
}

function resolveDefaultProjectWorkspaceInfo(
  issue: Pick<Issue, "projectId">,
  {
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: Pick<InboxWorkspaceGroupingOptions, "projectWorkspaceById" | "defaultProjectWorkspaceIdByProjectId">,
): { id: string; label: string } | null {
  if (!issue.projectId) return null;
  const defaultProjectWorkspaceId = defaultProjectWorkspaceIdByProjectId?.get(issue.projectId) ?? null;
  if (!defaultProjectWorkspaceId) return null;
  return {
    id: defaultProjectWorkspaceId,
    label: formatDefaultWorkspaceGroupLabel(projectWorkspaceById?.get(defaultProjectWorkspaceId)?.name),
  };
}

export function resolveIssueWorkspaceName(
  issue: Pick<Issue, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions,
): string | null {
  const defaultProjectWorkspaceId = issue.projectId
    ? defaultProjectWorkspaceIdByProjectId?.get(issue.projectId) ?? null
    : null;

  if (issue.executionWorkspaceId) {
    const executionWorkspace = executionWorkspaceById?.get(issue.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? issue.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace" && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;

    const workspaceName = executionWorkspace?.name;
    if (workspaceName) return workspaceName;
  }

  if (issue.projectWorkspaceId) {
    if (issue.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    const workspaceName = projectWorkspaceById?.get(issue.projectWorkspaceId)?.name;
    if (workspaceName) return workspaceName;
  }

  return null;
}

export function resolveIssueWorkspaceGroup(
  issue: Pick<Issue, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions = {},
): { key: string; label: string } {
  const defaultProjectWorkspace = resolveDefaultProjectWorkspaceInfo(issue, {
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  });

  if (issue.executionWorkspaceId) {
    const executionWorkspace = executionWorkspaceById?.get(issue.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? issue.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace"
      && linkedProjectWorkspaceId != null
      && linkedProjectWorkspaceId === defaultProjectWorkspace?.id;

    if (isDefaultSharedExecutionWorkspace && defaultProjectWorkspace) {
      return {
        key: `workspace:project:${defaultProjectWorkspace.id}`,
        label: defaultProjectWorkspace.label,
      };
    }

    const workspaceName = executionWorkspace?.name?.trim();
    if (workspaceName) {
      return {
        key: `workspace:execution:${issue.executionWorkspaceId}`,
        label: workspaceName,
      };
    }
  }

  if (issue.projectWorkspaceId) {
    if (issue.projectWorkspaceId === defaultProjectWorkspace?.id) {
      return {
        key: `workspace:project:${defaultProjectWorkspace.id}`,
        label: defaultProjectWorkspace.label,
      };
    }

    const workspaceName = projectWorkspaceById?.get(issue.projectWorkspaceId)?.name?.trim();
    if (workspaceName) {
      return {
        key: `workspace:project:${issue.projectWorkspaceId}`,
        label: workspaceName,
      };
    }
  }

  if (defaultProjectWorkspace) {
    return {
      key: `workspace:project:${defaultProjectWorkspace.id}`,
      label: defaultProjectWorkspace.label,
    };
  }

  return {
    key: "workspace:none",
    label: "No workspace",
  };
}

export function loadInboxNesting(): boolean {
  try {
    const raw = localStorage.getItem(INBOX_NESTING_KEY);
    return raw !== "false";
  } catch {
    return true;
  }
}

export function saveInboxNesting(enabled: boolean) {
  try {
    localStorage.setItem(INBOX_NESTING_KEY, String(enabled));
  } catch {
    // Ignore localStorage failures.
  }
}

export function resolveInboxNestingEnabled(preferenceEnabled: boolean, isMobile: boolean): boolean {
  return preferenceEnabled && !isMobile;
}

export function loadLastInboxTab(): InboxTab {
  try {
    const raw = localStorage.getItem(INBOX_LAST_TAB_KEY);
    if (raw === "all" || raw === "unread" || raw === "recent" || raw === "mine") return raw;
    if (raw === "new") return "mine";
    return "mine";
  } catch {
    return "mine";
  }
}

export function saveLastInboxTab(tab: InboxTab) {
  try {
    localStorage.setItem(INBOX_LAST_TAB_KEY, tab);
  } catch {
    // Ignore localStorage failures.
  }
}

export function isMineInboxTab(tab: InboxTab): boolean {
  return tab === "mine";
}

export function resolveInboxSelectionIndex(
  previousIndex: number,
  itemCount: number,
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return -1;
  return Math.min(previousIndex, itemCount - 1);
}

export function getInboxKeyboardSelectionIndex(
  previousIndex: number,
  itemCount: number,
  direction: "next" | "previous",
): number {
  if (itemCount === 0) return -1;
  if (previousIndex < 0) return 0;
  return direction === "next"
    ? Math.min(previousIndex + 1, itemCount - 1)
    : Math.max(previousIndex - 1, 0);
}

export function getLatestFailedRunsByAgent(runs: HeartbeatRun[]): HeartbeatRun[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latestByAgent = new Map<string, HeartbeatRun>();

  for (const run of sorted) {
    if (!latestByAgent.has(run.agentId)) {
      latestByAgent.set(run.agentId, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) => FAILED_RUN_STATUSES.has(run.status));
}

export function normalizeTimestamp(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function issueLastActivityTimestamp(issue: Issue): number {
  const lastActivityAt = normalizeTimestamp(issue.lastActivityAt);
  if (lastActivityAt > 0) return lastActivityAt;

  const lastExternalCommentAt = normalizeTimestamp(issue.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  return normalizeTimestamp(issue.updatedAt);
}

export function sortIssuesByMostRecentActivity(a: Issue, b: Issue): number {
  const activityDiff = issueLastActivityTimestamp(b) - issueLastActivityTimestamp(a);
  if (activityDiff !== 0) return activityDiff;
  return normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt);
}

export function getRecentTouchedIssues(issues: Issue[]): Issue[] {
  return [...issues].sort(sortIssuesByMostRecentActivity).slice(0, RECENT_ISSUES_LIMIT);
}

export function getUnreadTouchedIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => issue.isUnreadForMe);
}

export function getApprovalsForTab(
  approvals: Approval[],
  tab: InboxTab,
  filter: InboxApprovalFilter,
): Approval[] {
  const sortedApprovals = [...approvals].sort(
    (a, b) => normalizeTimestamp(b.updatedAt) - normalizeTimestamp(a.updatedAt),
  );

  if (tab === "mine" || tab === "recent") return sortedApprovals;
  if (tab === "unread") {
    return sortedApprovals.filter((approval) => ACTIONABLE_APPROVAL_STATUSES.has(approval.status));
  }
  if (filter === "all") return sortedApprovals;

  return sortedApprovals.filter((approval) => {
    const isActionable = ACTIONABLE_APPROVAL_STATUSES.has(approval.status);
    return filter === "actionable" ? isActionable : !isActionable;
  });
}

export function approvalActivityTimestamp(approval: Approval): number {
  const updatedAt = normalizeTimestamp(approval.updatedAt);
  if (updatedAt > 0) return updatedAt;
  return normalizeTimestamp(approval.createdAt);
}

export function getInboxWorkItems({
  issues,
  approvals,
  failedRuns = [],
  joinRequests = [],
}: {
  issues: Issue[];
  approvals: Approval[];
  failedRuns?: HeartbeatRun[];
  joinRequests?: JoinRequest[];
}): InboxWorkItem[] {
  return [
    ...issues.map((issue) => ({
      kind: "issue" as const,
      timestamp: issueLastActivityTimestamp(issue),
      issue,
    })),
    ...approvals.map((approval) => ({
      kind: "approval" as const,
      timestamp: approvalActivityTimestamp(approval),
      approval,
    })),
    ...failedRuns.map((run) => ({
      kind: "failed_run" as const,
      timestamp: normalizeTimestamp(run.createdAt),
      run,
    })),
    ...joinRequests.map((joinRequest) => ({
      kind: "join_request" as const,
      timestamp: normalizeTimestamp(joinRequest.createdAt),
      joinRequest,
    })),
  ].sort((a, b) => {
    const timestampDiff = b.timestamp - a.timestamp;
    if (timestampDiff !== 0) return timestampDiff;

    if (a.kind === "issue" && b.kind === "issue") {
      return sortIssuesByMostRecentActivity(a.issue, b.issue);
    }
    if (a.kind === "approval" && b.kind === "approval") {
      return approvalActivityTimestamp(b.approval) - approvalActivityTimestamp(a.approval);
    }

    return a.kind === "approval" ? -1 : 1;
  });
}

const inboxWorkItemKindOrder: InboxWorkItem["kind"][] = [
  "issue",
  "approval",
  "failed_run",
  "join_request",
];

const inboxWorkItemKindLabels: Record<InboxWorkItem["kind"], string> = {
  issue: "Issues",
  approval: "Approvals",
  failed_run: "Failed runs",
  join_request: "Join requests",
};

export function groupInboxWorkItems(
  items: InboxWorkItem[],
  groupBy: InboxWorkItemGroupBy,
  options: InboxWorkspaceGroupingOptions = {},
): InboxWorkItemGroup[] {
  if (groupBy === "none") {
    return [{ key: "__all", label: null, items }];
  }

  if (groupBy === "workspace") {
    const groups = new Map<string, { label: string; items: InboxWorkItem[]; latestTimestamp: number }>();
    for (const item of items) {
      const resolvedGroup = item.kind === "issue"
        ? resolveIssueWorkspaceGroup(item.issue, options)
        : { key: `kind:${item.kind}`, label: inboxWorkItemKindLabels[item.kind] };
      const existing = groups.get(resolvedGroup.key);
      if (existing) {
        existing.items.push(item);
        existing.latestTimestamp = Math.max(existing.latestTimestamp, item.timestamp);
      } else {
        groups.set(resolvedGroup.key, {
          label: resolvedGroup.label,
          items: [item],
          latestTimestamp: item.timestamp,
        });
      }
    }

    return [...groups.entries()]
      .map(([key, value]) => ({
        key,
        label: value.label,
        items: value.items,
        latestTimestamp: value.latestTimestamp,
      }))
      .sort((a, b) => {
        const timestampDiff = b.latestTimestamp - a.latestTimestamp;
        if (timestampDiff !== 0) return timestampDiff;
        return a.label.localeCompare(b.label);
      })
      .map(({ key, label, items: groupItems }) => ({
        key,
        label,
        items: groupItems,
      }));
  }

  const groups = new Map<InboxWorkItem["kind"], InboxWorkItem[]>();
  for (const item of items) {
    const existing = groups.get(item.kind) ?? [];
    existing.push(item);
    groups.set(item.kind, existing);
  }

  const orderedGroups: InboxWorkItemGroup[] = [];
  for (const kind of inboxWorkItemKindOrder) {
    const groupItems = groups.get(kind) ?? [];
    if (groupItems.length === 0) continue;
    orderedGroups.push({
        key: kind,
        label: inboxWorkItemKindLabels[kind],
        items: groupItems,
    });
  }
  return orderedGroups;
}

/**
 * Groups parent-child issues in a flat InboxWorkItem list.
 *
 * - Children whose parent is also in the list are removed from the top level
 *   and stored in `childrenByIssueId`.
 * - The parent's sort timestamp becomes max(parent, children) so that a group
 *   with a recently-updated child floats to the top.
 * - If a parent is absent (e.g. archived), children remain as independent roots.
 */
export function buildInboxNesting(items: InboxWorkItem[]): {
  displayItems: InboxWorkItem[];
  childrenByIssueId: Map<string, Issue[]>;
} {
  const issueItems: (InboxWorkItem & { kind: "issue" })[] = [];
  const nonIssueItems: InboxWorkItem[] = [];
  for (const item of items) {
    if (item.kind === "issue") issueItems.push(item as InboxWorkItem & { kind: "issue" });
    else nonIssueItems.push(item);
  }

  const issueIdSet = new Set(issueItems.map((i) => i.issue.id));
  const childrenByIssueId = new Map<string, Issue[]>();
  const childIds = new Set<string>();

  for (const item of issueItems) {
    const { issue } = item;
    if (issue.parentId && issueIdSet.has(issue.parentId)) {
      childIds.add(issue.id);
      const arr = childrenByIssueId.get(issue.parentId) ?? [];
      arr.push(issue);
      childrenByIssueId.set(issue.parentId, arr);
    }
  }

  // Sort each child list by most recent activity
  for (const children of childrenByIssueId.values()) {
    children.sort(sortIssuesByMostRecentActivity);
  }

  // Build root issue items with group-adjusted timestamps
  const rootIssueItems: InboxWorkItem[] = issueItems
    .filter((item) => !childIds.has(item.issue.id))
    .map((item) => {
      const children = childrenByIssueId.get(item.issue.id);
      if (!children?.length) return item;
      const maxChildTs = Math.max(...children.map(issueLastActivityTimestamp));
      return { ...item, timestamp: Math.max(item.timestamp, maxChildTs) };
    });

  // Merge and re-sort
  const displayItems = [...rootIssueItems, ...nonIssueItems].sort((a, b) => {
    const diff = b.timestamp - a.timestamp;
    if (diff !== 0) return diff;
    if (a.kind === "issue" && b.kind === "issue") {
      return sortIssuesByMostRecentActivity(a.issue, b.issue);
    }
    return 0;
  });

  return { displayItems, childrenByIssueId };
}

export function getInboxWorkItemKey(item: InboxWorkItem): string {
  if (item.kind === "issue") return `issue:${item.issue.id}`;
  if (item.kind === "approval") return `approval:${item.approval.id}`;
  if (item.kind === "failed_run") return `run:${item.run.id}`;
  return `join:${item.joinRequest.id}`;
}

export function buildInboxKeyboardNavEntries(
  groupedSections: ReadonlyArray<InboxKeyboardGroupSection>,
  collapsedGroupKeys: ReadonlySet<string>,
  collapsedInboxParents: ReadonlySet<string>,
): InboxKeyboardNavEntry[] {
  const entries: InboxKeyboardNavEntry[] = [];

  for (const group of groupedSections) {
    if (collapsedGroupKeys.has(group.key)) continue;

    for (const item of group.displayItems) {
      entries.push({
        type: "top",
        itemKey: `${group.key}:${getInboxWorkItemKey(item)}`,
        item,
      });

      if (item.kind !== "issue") continue;

      const children = group.childrenByIssueId.get(item.issue.id);
      if (!children?.length || collapsedInboxParents.has(item.issue.id)) continue;

      for (const child of children) {
        entries.push({
          type: "child",
          issueId: child.id,
          issue: child,
        });
      }
    }
  }

  return entries;
}

export function shouldShowInboxSection({
  tab,
  hasItems,
  showOnMine,
  showOnRecent,
  showOnUnread,
  showOnAll,
}: {
  tab: InboxTab;
  hasItems: boolean;
  showOnMine: boolean;
  showOnRecent: boolean;
  showOnUnread: boolean;
  showOnAll: boolean;
}): boolean {
  if (!hasItems) return false;
  if (tab === "mine") return showOnMine;
  if (tab === "recent") return showOnRecent;
  if (tab === "unread") return showOnUnread;
  return showOnAll;
}

export function computeInboxBadgeData({
  approvals,
  joinRequests,
  dashboard,
  heartbeatRuns,
  mineIssues,
  dismissedAlerts,
  dismissedAtByKey,
}: {
  approvals: Approval[];
  joinRequests: JoinRequest[];
  dashboard: DashboardSummary | undefined;
  heartbeatRuns: HeartbeatRun[];
  mineIssues: Issue[];
  dismissedAlerts: Set<string>;
  dismissedAtByKey: ReadonlyMap<string, number>;
}): InboxBadgeData {
  const actionableApprovals = approvals.filter(
    (approval) =>
      ACTIONABLE_APPROVAL_STATUSES.has(approval.status) &&
      !isInboxEntityDismissed(dismissedAtByKey, `approval:${approval.id}`, approval.updatedAt),
  ).length;
  const failedRuns = getLatestFailedRunsByAgent(heartbeatRuns).filter(
    (run) => !isInboxEntityDismissed(dismissedAtByKey, `run:${run.id}`, run.createdAt),
  ).length;
  const visibleJoinRequests = joinRequests.filter(
    (jr) => !isInboxEntityDismissed(dismissedAtByKey, `join:${jr.id}`, jr.updatedAt ?? jr.createdAt),
  ).length;
  const visibleMineIssues = mineIssues.filter((issue) => issue.isUnreadForMe).length;
  const agentErrorCount = dashboard?.agents.error ?? 0;
  const monthBudgetCents = dashboard?.costs.monthBudgetCents ?? 0;
  const monthUtilizationPercent = dashboard?.costs.monthUtilizationPercent ?? 0;
  const showAggregateAgentError =
    agentErrorCount > 0 &&
    failedRuns === 0 &&
    !dismissedAlerts.has("alert:agent-errors");
  const showBudgetAlert =
    monthBudgetCents > 0 &&
    monthUtilizationPercent >= 80 &&
    !dismissedAlerts.has("alert:budget");
  const alerts = Number(showAggregateAgentError) + Number(showBudgetAlert);

  return {
    inbox: actionableApprovals + visibleJoinRequests + failedRuns + visibleMineIssues + alerts,
    approvals: actionableApprovals,
    failedRuns,
    joinRequests: visibleJoinRequests,
    mineIssues: visibleMineIssues,
    alerts,
  };
}
