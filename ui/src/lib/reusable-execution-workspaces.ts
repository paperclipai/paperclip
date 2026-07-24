import { scoreFuzzyTextFields } from "./searchable-select";

export interface ReusableExecutionWorkspaceLike {
  id: string;
  name: string;
  cwd: string | null;
  lastUsedAt: Date | string;
  status?: string;
  branchName?: string | null;
}

const RECENT_WORKSPACE_CUTOFF_DAYS = 3;

export type ReusableWorkspaceOptionGroupId = "recent" | "all";

export interface ReusableWorkspaceOption<TWorkspace extends ReusableExecutionWorkspaceLike = ReusableExecutionWorkspaceLike> {
  key: string;
  value: string;
  workspaceId: string;
  groupId: ReusableWorkspaceOptionGroupId;
  label: string;
  description: string;
  searchText: string;
  workspace: TWorkspace;
}

export interface ReusableWorkspaceOptionGroup<TWorkspace extends ReusableExecutionWorkspaceLike = ReusableExecutionWorkspaceLike> {
  id: ReusableWorkspaceOptionGroupId;
  label: string;
  options: ReusableWorkspaceOption<TWorkspace>[];
}

function workspaceLastUsedTime(workspace: Pick<ReusableExecutionWorkspaceLike, "lastUsedAt">) {
  const time = new Date(workspace.lastUsedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function compareWorkspaceNames(a: ReusableExecutionWorkspaceLike, b: ReusableExecutionWorkspaceLike) {
  const nameCompare = a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameCompare !== 0) return nameCompare;
  return a.id.localeCompare(b.id);
}

function compareWorkspaceLastUsedDesc(a: ReusableExecutionWorkspaceLike, b: ReusableExecutionWorkspaceLike) {
  const timeCompare = workspaceLastUsedTime(b) - workspaceLastUsedTime(a);
  if (timeCompare !== 0) return timeCompare;
  return compareWorkspaceNames(a, b);
}

function workspaceDescription(workspace: ReusableExecutionWorkspaceLike) {
  return workspace.branchName ?? workspace.cwd ?? workspace.id.slice(0, 8);
}

function workspaceSearchText(workspace: ReusableExecutionWorkspaceLike) {
  return [
    workspace.name,
    workspace.status,
    workspace.branchName,
    workspace.cwd,
    workspace.id,
  ].filter(Boolean).join(" ");
}

export function dedupeReusableExecutionWorkspaces<T extends ReusableExecutionWorkspaceLike>(
  workspaces: readonly T[],
): T[] {
  const deduplicatedByPath = new Map<string, T>();

  for (const workspace of workspaces) {
    const key = workspace.cwd ?? workspace.id;
    const existing = deduplicatedByPath.get(key);
    if (!existing || workspaceLastUsedTime(workspace) > workspaceLastUsedTime(existing)) {
      deduplicatedByPath.set(key, workspace);
    }
  }

  return Array.from(deduplicatedByPath.values());
}

export function orderReusableExecutionWorkspaces<T extends ReusableExecutionWorkspaceLike>(
  workspaces: readonly T[],
): T[] {
  const alphabetized = dedupeReusableExecutionWorkspaces(workspaces).sort(compareWorkspaceNames);
  if (alphabetized.length <= 1) return alphabetized;

  let mostRecentlyUsed = alphabetized[0]!;
  for (const workspace of alphabetized.slice(1)) {
    if (workspaceLastUsedTime(workspace) > workspaceLastUsedTime(mostRecentlyUsed)) {
      mostRecentlyUsed = workspace;
    }
  }

  return [
    mostRecentlyUsed,
    ...alphabetized.filter((workspace) => workspace.id !== mostRecentlyUsed.id),
  ];
}

export function buildReusableExecutionWorkspaceOptionGroups<T extends ReusableExecutionWorkspaceLike>(
  workspaces: readonly T[],
  options: { now?: Date | string; recentCutoffDays?: number } = {},
): ReusableWorkspaceOptionGroup<T>[] {
  const nowTime = options.now ? new Date(options.now).getTime() : Date.now();
  const cutoffDays = options.recentCutoffDays ?? RECENT_WORKSPACE_CUTOFF_DAYS;
  const cutoffTime = nowTime - cutoffDays * 24 * 60 * 60 * 1000;
  const deduplicated = dedupeReusableExecutionWorkspaces(workspaces);

  const toOption = (
    workspace: T,
    groupId: ReusableWorkspaceOptionGroupId,
  ): ReusableWorkspaceOption<T> => ({
    key: `${groupId}:${workspace.id}`,
    value: workspace.id,
    workspaceId: workspace.id,
    groupId,
    label: workspace.name,
    description: workspaceDescription(workspace),
    searchText: workspaceSearchText(workspace),
    workspace,
  });

  const recent = deduplicated
    .filter((workspace) => workspaceLastUsedTime(workspace) >= cutoffTime)
    .sort(compareWorkspaceLastUsedDesc)
    .map((workspace) => toOption(workspace, "recent"));

  const all = [...deduplicated]
    .sort(compareWorkspaceNames)
    .map((workspace) => toOption(workspace, "all"));

  return [
    ...(recent.length > 0 ? [{ id: "recent" as const, label: "Recent", options: recent }] : []),
    { id: "all", label: "All workspaces", options: all },
  ];
}

export function reusableWorkspaceOptionMatches(
  option: Pick<ReusableWorkspaceOption, "label" | "description" | "searchText">,
  query: string,
) {
  return scoreReusableWorkspaceOptionMatch(option, query) !== null;
}

export function scoreReusableWorkspaceOptionMatch(
  option: Pick<ReusableWorkspaceOption, "label" | "description" | "searchText">,
  query: string,
) {
  return scoreFuzzyTextFields([
    { text: option.label, weight: 0 },
    { text: option.description, weight: 20 },
    { text: option.searchText, weight: 40 },
  ], query);
}
