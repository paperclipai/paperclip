import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { companiesApi } from "../api/companies";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { roadmapApi } from "../api/roadmap";
import { queryKeys } from "../lib/queryKeys";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { groupBy } from "../lib/groupBy";
import { formatIssueStatusLabel } from "../lib/issue-status-labels";
import {
  epicButtonClassName,
  epicTone,
  extractRoadmapEpicIdsFromIssue,
  pickRoadmapOverviewField,
} from "../lib/roadmapEpicStyles";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { IssueRow } from "./IssueRow";
import { IssueBoardStateSummary } from "./IssueBoardStateSummary";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, Filter, ArrowUpDown, Layers, Check, X, ChevronRight, List, Columns3, User, Search, Pause, Play } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import { buildIssueTree, countDescendants } from "../lib/issue-tree";
import type { Issue, IssueRelationIssueSummary } from "@paperclipai/shared";

/* ── Helpers ── */

const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
const priorityOrder = ["critical", "high", "medium", "low"];
const statusLabel = formatIssueStatusLabel;
const OPEN_RECOVERY_SUCCESSOR_STATUSES = new Set<Issue["status"]>([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

interface EpicPresentation {
  id: string;
  title: string;
  count: number;
  order: number;
  sectionTitle: string | null;
  overview: { key: string; value: string } | null;
}

function isDoneEquivalent(status: Issue["status"]): boolean {
  return status === "done" || status === "cancelled";
}

function blockedOnMeSummary(blockers: IssueRelationIssueSummary[]): string {
  if (blockers.length === 0) return "";
  if (blockers.length === 1) {
    return `Waiting on ${blockers[0].identifier ?? blockers[0].title}`;
  }
  return `Waiting on ${blockers.length} of your issues`;
}

function shouldHideRecoverySourceIssue(issue: Issue) {
  if (issue.status !== "blocked") return false;
  const successorStatus = issue.recoverySuccessor?.status;
  return successorStatus ? OPEN_RECOVERY_SUCCESSOR_STATUSES.has(successorStatus) : false;
}

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function issueMostRecentTimestamp(issue: Issue): number {
  if (issue.status === "done") {
    const completedAt = normalizeTimestamp(issue.completedAt);
    if (completedAt > 0) return completedAt;
  }

  if (issue.status === "cancelled") {
    const cancelledAt = normalizeTimestamp(issue.cancelledAt);
    if (cancelledAt > 0) return cancelledAt;
  }

  const lastActivityAt = normalizeTimestamp(issue.lastActivityAt);
  if (lastActivityAt > 0) return lastActivityAt;

  const lastExternalCommentAt = normalizeTimestamp(issue.lastExternalCommentAt);
  if (lastExternalCommentAt > 0) return lastExternalCommentAt;

  return normalizeTimestamp(issue.updatedAt) || normalizeTimestamp(issue.createdAt);
}

function defaultSortDirForField(field: IssueViewState["sortField"]): IssueViewState["sortDir"] {
  return field === "recent" ? "desc" : "asc";
}

function createDefaultViewState(defaultStatuses: readonly Issue["status"][] = []): IssueViewState {
  return {
    statuses: [...defaultStatuses],
    priorities: [],
    assignees: [],
    labels: [],
    projects: [],
    epicId: null,
    sortField: "recent",
    sortDir: "desc",
    groupBy: "none",
    viewMode: "list",
    collapsedGroups: [],
    collapsedParents: [],
  };
}

function defaultFilterPatch(
  defaultStatuses: readonly Issue["status"][] = [],
): Pick<IssueViewState, "statuses" | "priorities" | "assignees" | "labels" | "projects" | "epicId"> {
  return {
    statuses: [...defaultStatuses],
    priorities: [],
    assignees: [],
    labels: [],
    projects: [],
    epicId: null,
  };
}

/* ── View state ── */

export type IssueViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  projects: string[];
  epicId: string | null;
  sortField: "status" | "priority" | "title" | "created" | "recent";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
  collapsedParents: string[];
};

const quickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

const ISSUE_VIEW_STATE_SCHEMA_VERSION = 4;

type PersistedIssueViewState = Partial<Omit<IssueViewState, "sortField">> & {
  sortField?: IssueViewState["sortField"] | "updated";
  schemaVersion?: number;
};

function normalizePersistedViewState(
  raw: PersistedIssueViewState,
  defaultStatuses: readonly Issue["status"][] = [],
): IssueViewState {
  const schemaVersion = raw.schemaVersion ?? 1;
  const baseState = createDefaultViewState(defaultStatuses);
  const { schemaVersion: _schemaVersion, ...rawWithoutSchemaVersion } = raw;
  const migrated: IssueViewState = {
    ...baseState,
    ...rawWithoutSchemaVersion,
    sortField: raw.sortField === "updated" ? "recent" : (raw.sortField ?? baseState.sortField),
  };

  // The old persisted "updated" field predates the dedicated semantic recent sort.
  // Always remap it to the new default recency ordering on top.
  if (raw.sortField === "updated") {
    migrated.sortDir = "desc";
  }

  // Pre-v4 issue views treated an empty status array as "show everything".
  // v4 allows callers to define a baseline status set, so upgrade legacy empty
  // selections to that caller-provided default while preserving explicit v4
  // "show everything" choices.
  if (
    schemaVersion < ISSUE_VIEW_STATE_SCHEMA_VERSION
    && Array.isArray(raw.statuses)
    && raw.statuses.length === 0
    && defaultStatuses.length > 0
  ) {
    migrated.statuses = [...defaultStatuses];
  }

  return migrated;
}

function getViewState(key: string, defaultStatuses: readonly Issue["status"][] = []): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedIssueViewState;
      const migrated = normalizePersistedViewState(parsed, defaultStatuses);
      if ((parsed.schemaVersion ?? 1) < ISSUE_VIEW_STATE_SCHEMA_VERSION) {
        localStorage.setItem(
          key,
          JSON.stringify({
            schemaVersion: ISSUE_VIEW_STATE_SCHEMA_VERSION,
            ...migrated,
          }),
        );
      }
      return migrated;
    }
  } catch { /* ignore */ }
  return createDefaultViewState(defaultStatuses);
}

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(
    key,
    JSON.stringify({
      schemaVersion: ISSUE_VIEW_STATE_SCHEMA_VERSION,
      ...state,
    }),
  );
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function applyFilters(
  issues: Issue[],
  state: IssueViewState,
  currentUserId?: string | null,
  epicIdsByIssueId?: Map<string, string[]>,
): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
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
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  if (state.projects.length > 0) result = result.filter((i) => i.projectId != null && state.projects.includes(i.projectId));
  if (state.epicId) {
    const selectedEpicId = state.epicId;
    result = result.filter((issue) => {
      const epicIds = epicIdsByIssueId?.get(issue.id) ?? extractRoadmapEpicIdsFromIssue(issue);
      return epicIds.includes(selectedEpicId);
    });
  }
  return result;
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      case "priority":
        return dir * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "recent":
        return dir * (
          issueMostRecentTimestamp(a) - issueMostRecentTimestamp(b)
          || normalizeTimestamp(a.updatedAt) - normalizeTimestamp(b.updatedAt)
          || normalizeTimestamp(a.createdAt) - normalizeTimestamp(b.createdAt)
          || a.title.localeCompare(b.title)
        );
      default:
        return 0;
    }
  });
  return sorted;
}

function countActiveFilters(state: IssueViewState, defaultStatuses: readonly Issue["status"][] = []): number {
  let count = 0;
  if (!arraysEqual(state.statuses, defaultStatuses)) count++;
  if (state.priorities.length > 0) count++;
  if (state.assignees.length > 0) count++;
  if (state.labels.length > 0) count++;
  if (state.projects.length > 0) count++;
  if (state.epicId) count++;
  return count;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  defaultStatuses?: readonly Issue["status"][];
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialSearch?: string;
  searchFilters?: {
    participantAgentId?: string;
  };
  excludeRecoverySourcesWithOpenSuccessors?: boolean;
  onArchiveClosed?: () => void;
  archiveClosedPending?: boolean;
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  defaultStatuses = [],
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialSearch,
  searchFilters,
  excludeRecoverySourcesWithOpenSuccessors = false,
  onArchiveClosed,
  archiveClosedPending = false,
  onSearchChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;
  const defaultStatusKey = defaultStatuses.join(",");
  const viewConfigKey = `${scopedKey}:${defaultStatusKey}`;
  const defaultFilters = useMemo(() => defaultFilterPatch(defaultStatuses), [defaultStatusKey]);

  const [viewState, setViewState] = useState<IssueViewState>(() => {
    if (initialAssignees) {
      return { ...createDefaultViewState(defaultStatuses), assignees: initialAssignees };
    }
    return getViewState(scopedKey, defaultStatuses);
  });
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const deferredIssueSearch = useDeferredValue(issueSearch);
  const normalizedIssueSearch = deferredIssueSearch.trim().toLowerCase();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  // Reload view state from localStorage when company changes (scopedKey changes).
  const prevViewConfigKey = useRef(viewConfigKey);
  useEffect(() => {
    if (prevViewConfigKey.current !== viewConfigKey) {
      prevViewConfigKey.current = viewConfigKey;
      setViewState(initialAssignees
        ? { ...createDefaultViewState(defaultStatuses), assignees: initialAssignees }
        : getViewState(scopedKey, defaultStatuses));
    }
  }, [viewConfigKey, scopedKey, initialAssignees, defaultStatuses]);

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
      excludeRecoverySourcesWithOpenSuccessors ? "exclude-recovery-sources-open-successors" : "include-recovery-sources-open-successors",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        q: normalizedIssueSearch,
        projectId,
        ...searchFilters,
        ...(excludeRecoverySourcesWithOpenSuccessors ? { excludeRecoverySourcesWithOpenSuccessors: true } : {}),
      }),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0,
    placeholderData: (previousData) => previousData,
  });

  const { data: roadmapData } = useQuery({
    queryKey: queryKeys.roadmap(selectedCompanyId),
    queryFn: () => roadmapApi.get(selectedCompanyId),
    enabled: !!selectedCompanyId,
  });

  const { data: pausedRoadmapEpics } = useQuery({
    queryKey: queryKeys.companies.roadmapEpics(selectedCompanyId ?? ""),
    queryFn: () => companiesApi.listRoadmapEpics(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const sourceIssues = useMemo(() => {
    const baseIssues = normalizedIssueSearch.length > 0 ? searchedIssues : issues;
    if (!excludeRecoverySourcesWithOpenSuccessors) return baseIssues;
    return baseIssues.filter((issue) => !shouldHideRecoverySourceIssue(issue));
  }, [issues, searchedIssues, normalizedIssueSearch, excludeRecoverySourcesWithOpenSuccessors]);

  const epicIdsByIssueId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of sourceIssues) {
      map.set(issue.id, extractRoadmapEpicIdsFromIssue(issue));
    }
    return map;
  }, [sourceIssues]);

  const roadmapEpicMeta = useMemo(() => {
    const map = new Map<string, { title: string; order: number; sectionTitle: string | null; overview: { key: string; value: string } | null }>();
    const sections = roadmapData?.roadmap.sections ?? [];
    let order = 0;
    for (const section of sections) {
      for (const item of section.items) {
        map.set(item.id.toUpperCase(), {
          title: item.title,
          order,
          sectionTitle: section.title,
          overview: pickRoadmapOverviewField(item.fields),
        });
        order += 1;
      }
    }
    return map;
  }, [roadmapData]);

  const epicPills = useMemo(() => {
    const counts = new Map<string, number>();
    const issuesMatchingOtherFilters = applyFilters(
      sourceIssues,
      { ...viewState, epicId: null },
      currentUserId,
      epicIdsByIssueId,
    );
    for (const issue of issuesMatchingOtherFilters) {
      const ids = epicIdsByIssueId.get(issue.id) ?? [];
      for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    if (viewState.epicId && !counts.has(viewState.epicId)) {
      counts.set(viewState.epicId, 0);
    }
    return [...counts.entries()]
      .map(([id, count]) => {
        const normalizedId = id.toUpperCase();
        const roadmapMeta = roadmapEpicMeta.get(normalizedId);
        return {
          id,
          title: roadmapMeta?.title ?? id,
          count,
          order: roadmapMeta?.order ?? Number.MAX_SAFE_INTEGER,
          sectionTitle: roadmapMeta?.sectionTitle ?? null,
          overview: roadmapMeta?.overview ?? null,
        } satisfies EpicPresentation;
      })
      .sort((left, right) => {
        if (left.order !== right.order) return left.order - right.order;
        return left.id.localeCompare(right.id);
      });
  }, [sourceIssues, viewState, currentUserId, epicIdsByIssueId, roadmapEpicMeta]);

  const pausedEpicIds = useMemo(
    () => new Set((pausedRoadmapEpics?.pausedEpicIds ?? []).map((id) => id.toUpperCase())),
    [pausedRoadmapEpics?.pausedEpicIds],
  );

  const selectedEpic = useMemo(() => {
    if (!viewState.epicId) return null;
    const normalizedId = viewState.epicId.toUpperCase();
    return epicPills.find((epic) => epic.id.toUpperCase() === normalizedId) ?? {
      id: viewState.epicId,
      title: roadmapEpicMeta.get(normalizedId)?.title ?? viewState.epicId,
      count: 0,
      order: roadmapEpicMeta.get(normalizedId)?.order ?? Number.MAX_SAFE_INTEGER,
      sectionTitle: roadmapEpicMeta.get(normalizedId)?.sectionTitle ?? null,
      overview: roadmapEpicMeta.get(normalizedId)?.overview ?? null,
    };
  }, [viewState.epicId, epicPills, roadmapEpicMeta]);

  const selectedEpicPaused = selectedEpic ? pausedEpicIds.has(selectedEpic.id.toUpperCase()) : false;
  const selectedEpicComplete = useMemo(() => {
    if (!selectedEpic) return false;
    let issueCount = 0;
    for (const issue of issues) {
      const epicIds = extractRoadmapEpicIdsFromIssue(issue);
      if (!epicIds.includes(selectedEpic.id.toUpperCase())) continue;
      issueCount += 1;
      if (!isDoneEquivalent(issue.status)) return false;
    }
    return issueCount > 0;
  }, [selectedEpic, issues]);

  const toggleEpicPauseMutation = useMutation({
    mutationFn: async ({ epicId, pause }: { epicId: string; pause: boolean }) => {
      if (!selectedCompanyId) throw new Error("No selected company");
      if (pause) {
        return companiesApi.pauseRoadmapEpic(selectedCompanyId, epicId);
      }
      return companiesApi.resumeRoadmapEpic(selectedCompanyId, epicId);
    },
    onSuccess: async (_result, variables) => {
      if (!selectedCompanyId) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.roadmapEpics(selectedCompanyId) });
      pushToast({
        title: variables.pause ? "Epic paused" : "Epic resumed",
        body: roadmapEpicMeta.get(variables.epicId.toUpperCase())?.title ?? variables.epicId,
        tone: variables.pause ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update epic",
        body: error instanceof Error ? error.message : "Could not update roadmap epic state.",
        tone: "error",
      });
    },
  });

  const epicStylesByIssueId = useMemo(() => {
    const roadmapOrderFor = (epicId: string) => roadmapEpicMeta.get(epicId.toUpperCase())?.order ?? Number.MAX_SAFE_INTEGER;
    const map = new Map<string, { rowClassName: string; cardClassName: string }>();

    for (const issue of sourceIssues) {
      const epicIds = epicIdsByIssueId.get(issue.id) ?? [];
      if (epicIds.length === 0) continue;

      const selectedEpicId = selectedEpic && epicIds.includes(selectedEpic.id.toUpperCase())
        ? selectedEpic.id.toUpperCase()
        : null;
      const primaryEpicId = selectedEpicId
        ?? [...epicIds].sort((left, right) => roadmapOrderFor(left) - roadmapOrderFor(right) || left.localeCompare(right))[0];

      if (!primaryEpicId) continue;
      const tone = epicTone(primaryEpicId);
      map.set(issue.id, {
        rowClassName: cn("border-l-2 pl-[calc(theme(spacing.2)-2px)] sm:pl-[calc(theme(spacing.1)-2px)]", tone.row),
        cardClassName: tone.card,
      });
    }

    return map;
  }, [sourceIssues, epicIdsByIssueId, roadmapEpicMeta, selectedEpic]);

  const filtered = useMemo(() => {
    const filteredByControls = applyFilters(sourceIssues, viewState, currentUserId, epicIdsByIssueId);
    return sortIssues(filteredByControls, viewState);
  }, [sourceIssues, viewState, currentUserId, epicIdsByIssueId]);

  const blockedOnMeIssues = useMemo(() => {
    if (!currentUserId) return [];
    return issues
      .filter((issue) => issue.status === "blocked")
      .map((issue) => ({
        issue,
        blockers: (issue.blockedBy ?? []).filter(
          (blocker) => blocker.assigneeUserId === currentUserId && !isDoneEquivalent(blocker.status),
        ),
      }))
      .filter((entry) => entry.blockers.length > 0);
  }, [issues, currentUserId]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveFilters(viewState, defaultStatuses);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return statusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: statusLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return priorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: statusLabel(p), items: groups[p]! }));
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
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [filtered, viewState.groupBy, agents, agentName, currentUserId]);

  const newIssueDefaults = useCallback((groupKey?: string) => {
    const defaults: Record<string, string> = {};
    if (projectId) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
    }
    return defaults;
  }, [projectId, viewState.groupBy]);

  const assignIssue = useCallback((issueId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  }, [onUpdateIssue]);

  const toggleEpicFilter = useCallback((epicId: string) => {
    updateView({ epicId: viewState.epicId === epicId ? null : epicId });
  }, [updateView, viewState.epicId]);


  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openNewIssue(newIssueDefaults())}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">New Issue</span>
          </Button>
          <div className="relative w-48 sm:w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={issueSearch}
              onChange={(e) => {
                setIssueSearch(e.target.value);
                onSearchChange?.(e.target.value);
              }}
              placeholder="Search issues..."
              className="pl-7 text-xs sm:text-sm"
              aria-label="Search issues"
            />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          {onArchiveClosed && (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={onArchiveClosed}
              disabled={archiveClosedPending}
            >
              {archiveClosedPending ? "Archiving..." : "Archive Closed"}
            </Button>
          )}

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

          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className={`text-xs ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
                {activeFilterCount > 0 && (
                  <span className="sm:hidden text-[10px] font-medium ml-0.5">{activeFilterCount}</span>
                )}
                {activeFilterCount > 0 && (
                  <X
                    className="h-3 w-3 ml-1 hidden sm:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateView(defaultFilters);
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(480px,calc(100vw-2rem))] p-0">
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => updateView(defaultFilters)}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Quick filters */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Quick filters</span>
                  <div className="flex flex-wrap gap-1.5">
                    {quickFilterPresets.map((preset) => {
                      const isActive = arraysEqual(viewState.statuses, preset.statuses);
                      return (
                        <button
                          key={preset.label}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          }`}
                          onClick={() => {
                            const nextStatuses = isActive ? [] : [...preset.statuses];
                            updateView({ statuses: nextStatuses });
                          }}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border" />

                {/* Multi-column filter sections */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  {/* Status */}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <div className="space-y-0.5">
                      {statusOrder.map((s) => (
                        <label key={s} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.statuses.includes(s)}
                            onCheckedChange={() => {
                              const nextStatuses = toggleInArray(viewState.statuses, s);
                              updateView({ statuses: nextStatuses });
                            }}
                          />
                          <StatusIcon status={s} />
                          <span className="text-sm">{statusLabel(s)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Priority + Assignee stacked in right column */}
                  <div className="space-y-3">
                    {/* Priority */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Priority</span>
                      <div className="space-y-0.5">
                        {priorityOrder.map((p) => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.priorities.includes(p)}
                              onCheckedChange={() => updateView({ priorities: toggleInArray(viewState.priorities, p) })}
                            />
                            <PriorityIcon priority={p} />
                            <span className="text-sm">{statusLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Assignee */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Assignee</span>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto">
                        <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.assignees.includes("__unassigned")}
                            onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__unassigned") })}
                          />
                          <span className="text-sm">No assignee</span>
                        </label>
                        {currentUserId && (
                          <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.assignees.includes("__me")}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__me") })}
                            />
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm">Me</span>
                          </label>
                        )}
                        {(agents ?? []).map((agent) => (
                          <label key={agent.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.assignees.includes(agent.id)}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, agent.id) })}
                            />
                            <span className="text-sm">{agent.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {labels && labels.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {labels.map((label) => (
                            <label key={label.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.labels.includes(label.id)}
                                onCheckedChange={() => updateView({ labels: toggleInArray(viewState.labels, label.id) })}
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                              <span className="text-sm">{label.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {projects && projects.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Project</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {projects.map((project) => (
                            <label key={project.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.projects.includes(project.id)}
                                onCheckedChange={() => updateView({ projects: toggleInArray(viewState.projects, project.id) })}
                              />
                              <span className="text-sm">{project.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs">
                <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">Sort</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-0">
              <div className="p-2 space-y-0.5">
                {([
                  ["status", "Status"],
                  ["priority", "Priority"],
                  ["title", "Title"],
                  ["created", "Created"],
                  ["recent", "Most recent"],
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
                        updateView({ sortField: field, sortDir: defaultSortDirForField(field) });
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

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Group</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
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

      {epicPills.length > 0 && (
        <div className="space-y-3">
          <div className="sticky top-0 z-10 -mx-1 rounded-xl border border-border/70 bg-background/85 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="px-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Epics</span>
              {epicPills.map((epic) => {
                const isSelected = viewState.epicId === epic.id;
                const showsFallbackId = epic.title === epic.id;
                return (
                  <button
                    key={epic.id}
                    type="button"
                    title={epic.id}
                    data-epic-filter-pill={epic.id}
                    aria-pressed={isSelected}
                    className={cn(
                      "group inline-flex max-w-full items-center gap-2 rounded-full px-2.5 py-1 text-left text-xs",
                      epicButtonClassName(epicTone(epic.id), isSelected),
                    )}
                    onClick={() => toggleEpicFilter(epic.id)}
                  >
                    <span className="min-w-0 truncate font-medium">{epic.title}</span>
                    {showsFallbackId ? (
                      <span className="hidden font-mono text-[10px] opacity-70 lg:inline">{epic.id}</span>
                    ) : null}
                    {!isSelected ? (
                      <span className="rounded-full bg-black/8 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-white/10">
                        {epic.count}
                      </span>
                    ) : null}
                    {isSelected && <X className="h-3 w-3 shrink-0 opacity-70" />}
                  </button>
                );
              })}
            </div>
          </div>
          {selectedEpic && (
            <section
              className={cn(
                "relative overflow-hidden rounded-2xl border px-4 py-4 shadow-xs md:px-5 md:py-5",
                epicTone(selectedEpic.id).badge,
              )}
            >
              <div className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-current opacity-40" />
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-70">
                    Epic Focus
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold leading-tight">{selectedEpic.title}</h3>
                    {selectedEpicComplete ? (
                      <span className="rounded-full border border-emerald-700/20 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800 dark:border-emerald-300/20 dark:bg-emerald-900/40 dark:text-emerald-100">
                        Complete
                      </span>
                    ) : selectedEpicPaused ? (
                      <span className="rounded-full border border-current/20 bg-black/8 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] dark:bg-white/10">
                        Paused
                      </span>
                    ) : null}
                    {selectedEpic.sectionTitle ? (
                      <span className="rounded-full border border-current/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] opacity-75">
                        {selectedEpic.sectionTitle}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm font-medium opacity-85">
                    {selectedEpic.count} issue{selectedEpic.count === 1 ? "" : "s"} in scope
                  </p>
                  {selectedEpic.overview ? (
                    <div className="mt-3 max-w-3xl">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] opacity-70">
                        {selectedEpic.overview.key}
                      </p>
                      <p className="mt-1 text-sm leading-6 opacity-90">{selectedEpic.overview.value}</p>
                    </div>
                  ) : (
                    <p className="mt-3 max-w-3xl text-sm leading-6 opacity-80">
                      No roadmap description is available for this epic yet.
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-current/20 bg-background/80 hover:bg-background"
                    onClick={() => updateView({ epicId: null })}
                  >
                    All Issues
                  </Button>
                  {selectedEpicComplete ? (
                    <span className="inline-flex items-center rounded-md border border-emerald-700/20 bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-300/20 dark:bg-emerald-900/40 dark:text-emerald-100">
                      Epic complete
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-current/20 bg-background/80 hover:bg-background"
                      disabled={toggleEpicPauseMutation.isPending}
                      onClick={() =>
                        toggleEpicPauseMutation.mutate({
                          epicId: selectedEpic.id,
                          pause: !selectedEpicPaused,
                        })
                      }
                    >
                      {selectedEpicPaused ? (
                        <>
                          <Play className="mr-1.5 h-3.5 w-3.5" />
                          Resume Epic
                        </>
                      ) : (
                        <>
                          <Pause className="mr-1.5 h-3.5 w-3.5" />
                          Pause Epic
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {blockedOnMeIssues.length > 0 && (
        <section
          data-testid="blocked-on-me-section"
          className="overflow-hidden rounded-xl border border-border bg-card/70 shadow-xs"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">What&apos;s blocked on me</h3>
                <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {blockedOnMeIssues.length} issue{blockedOnMeIssues.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Downstream work currently waiting on issues assigned to you.
              </p>
            </div>
          </div>
          <div className="bg-background/80">
            {blockedOnMeIssues.map(({ issue, blockers }) => (
              <IssueRow
                key={`blocked-on-me:${issue.id}`}
                issue={issue}
                issueLinkState={issueLinkState}
                mobileMeta={blockedOnMeSummary(blockers)}
                desktopTrailing={(
                  <span className="hidden items-center gap-1.5 overflow-hidden xl:flex xl:max-w-[360px]">
                    <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                      Waiting on
                    </span>
                    {blockers.slice(0, 2).map((blocker) => (
                      <span
                        key={blocker.id}
                        className="inline-flex max-w-[160px] items-center rounded-full border border-border bg-muted/55 px-2 py-0.5 text-[10px] font-medium text-foreground"
                        title={blocker.title}
                      >
                        <span className="truncate">{blocker.identifier ?? blocker.title}</span>
                      </span>
                    ))}
                    {blockers.length > 2 && (
                      <span className="text-[10px] text-muted-foreground">+{blockers.length - 2}</span>
                    )}
                  </span>
                )}
              />
            ))}
          </div>
        </section>
      )}

      {isLoading && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <EmptyState
          icon={CircleDot}
          message="No issues match the current filters or search."
          action="Create Issue"
          onAction={() => openNewIssue(newIssueDefaults())}
        />
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
          epicStylesByIssueId={epicStylesByIssueId}
          onUpdateIssue={onUpdateIssue}
        />
      ) : (
        groupedContent.map((group) => (
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
              <div className="flex items-center py-1.5 pl-1 pr-3">
                <CollapsibleTrigger className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className="text-sm font-semibold uppercase tracking-wide">
                    {group.label}
                  </span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => openNewIssue(newIssueDefaults(group.key))}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleContent>
              {(() => {
                const { roots, childMap } = buildIssueTree(group.items);

                const renderIssueRow = (issue: Issue, depth: number) => {
                  const children = childMap.get(issue.id) ?? [];
                  const issueEpicIds = epicIdsByIssueId.get(issue.id) ?? [];
                  const hasChildren = children.length > 0;
                  const totalDescendants = hasChildren ? countDescendants(issue.id, childMap) : 0;
                  const isExpanded = !viewState.collapsedParents.includes(issue.id);
                  const toggleCollapse = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
                    e.preventDefault();
                    e.stopPropagation();
                    updateView({
                      collapsedParents: isExpanded
                        ? [...viewState.collapsedParents, issue.id]
                        : viewState.collapsedParents.filter((id) => id !== issue.id),
                    });
                  };

                  return (
                    <div key={issue.id} style={depth > 0 ? { paddingLeft: `${depth * 16}px` } : undefined}>
                      <IssueRow
                        issue={issue}
                        issueLinkState={issueLinkState}
                        className={epicStylesByIssueId.get(issue.id)?.rowClassName}
                        titleSuffix={hasChildren && !isExpanded ? (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({totalDescendants} sub-task{totalDescendants !== 1 ? "s" : ""})
                          </span>
                        ) : undefined}
                        mobileLeading={
                          hasChildren ? (
                            <button type="button" onClick={toggleCollapse}>
                              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                            </button>
                          ) : (
                            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                              <StatusIcon status={issue.status} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
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
                            <span
                              className="hidden shrink-0 sm:inline-flex"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            >
                              <StatusIcon status={issue.status} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {liveIssueIds?.has(issue.id) && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 sm:gap-1.5 sm:px-2">
                                <span className="relative flex h-2 w-2">
                                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                                </span>
                                <span className="hidden text-[11px] font-medium text-blue-600 dark:text-blue-400 sm:inline">
                                  Live
                                </span>
                              </span>
                            )}
                          </>
                        )}
                        mobileMeta={<IssueBoardStateSummary issue={issue} />}
                        desktopTrailing={(
                          <>
                            {issueEpicIds.length > 0 && !viewState.epicId && (
                              <span className="hidden items-center gap-1 overflow-hidden xl:flex xl:max-w-[280px]">
                                {issueEpicIds.slice(0, 2).map((epicId) => {
                                  const isSelected = viewState.epicId === epicId;
                                  const roadmapMeta = roadmapEpicMeta.get(epicId.toUpperCase());
                                  const label = roadmapMeta?.title ?? epicId;
                                  const showsFallbackId = !roadmapMeta?.title;
                                  return (
                                    <button
                                      key={epicId}
                                      type="button"
                                      title={epicId}
                                      className={cn(
                                        "inline-flex max-w-[220px] items-center gap-1.5 rounded-full px-2 py-1 text-left text-[10px]",
                                        epicButtonClassName(epicTone(epicId), isSelected),
                                      )}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        toggleEpicFilter(epicId);
                                      }}
                                    >
                                      <span className="truncate font-medium">{label}</span>
                                      {showsFallbackId ? <span className="font-mono opacity-65">{epicId}</span> : null}
                                    </button>
                                  );
                                })}
                                {issueEpicIds.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground">+{issueEpicIds.length - 2}</span>
                                )}
                              </span>
                            )}
                            {(issue.labels ?? []).length > 0 && (
                              <span className="hidden items-center gap-1 overflow-hidden md:flex md:max-w-[240px]">
                                {(issue.labels ?? []).slice(0, 3).map((label) => (
                                  <span
                                    key={label.id}
                                    className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                                    style={{
                                      borderColor: label.color,
                                      color: pickTextColorForPillBg(label.color, 0.12),
                                      backgroundColor: `${label.color}1f`,
                                    }}
                                  >
                                    {label.name}
                                  </span>
                                ))}
                                {(issue.labels ?? []).length > 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    +{(issue.labels ?? []).length - 3}
                                  </span>
                                )}
                              </span>
                            )}
                            <Popover
                              open={assigneePickerIssueId === issue.id}
                              onOpenChange={(open) => {
                                setAssigneePickerIssueId(open ? issue.id : null);
                                if (!open) setAssigneeSearch("");
                              }}
                            >
                              <PopoverTrigger asChild>
                                <button
                                  className="flex w-[180px] shrink-0 items-center rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                >
                                  {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                                    <Identity name={agentName(issue.assigneeAgentId)!} size="sm" />
                                  ) : issue.assigneeUserId ? (
                                    <span className="inline-flex items-center gap-1.5 text-xs">
                                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                        <User className="h-3 w-3" />
                                      </span>
                                      {formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                        <User className="h-3 w-3" />
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
                          </>
                        )}
                        trailingMeta={<IssueBoardStateSummary issue={issue} className="max-w-[220px] justify-end" />}
                      />
                      {hasChildren && isExpanded && children.map((child) => renderIssueRow(child, depth + 1))}
                    </div>
                  );
                };

                return roots.map((issue) => renderIssueRow(issue, 0));
              })()}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </div>
  );
}
