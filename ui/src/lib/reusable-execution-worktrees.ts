import { scoreFuzzyTextFields } from "./searchable-select";

export interface ReusableExecutionWorktreeLike {
  id: string;
  name: string;
  cwd: string | null;
  lastUsedAt: Date | string;
  status?: string;
  branchName?: string | null;
}

const RECENT_WORKSPACE_CUTOFF_DAYS = 3;

export type ReusableWorktreeOptionGroupId = "recent" | "all";

export interface ReusableWorktreeOption<TWorktree extends ReusableExecutionWorktreeLike = ReusableExecutionWorktreeLike> {
  key: string;
  value: string;
  workspaceId: string;
  groupId: ReusableWorktreeOptionGroupId;
  label: string;
  description: string;
  searchText: string;
  workspace: TWorktree;
}

export interface ReusableWorktreeOptionGroup<TWorktree extends ReusableExecutionWorktreeLike = ReusableExecutionWorktreeLike> {
  id: ReusableWorktreeOptionGroupId;
  label: string;
  options: ReusableWorktreeOption<TWorktree>[];
}

function worktreeLastUsedTime(workspace: Pick<ReusableExecutionWorktreeLike, "lastUsedAt">) {
  const time = new Date(workspace.lastUsedAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

function compareWorktreeNames(a: ReusableExecutionWorktreeLike, b: ReusableExecutionWorktreeLike) {
  const nameCompare = a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (nameCompare !== 0) return nameCompare;
  return a.id.localeCompare(b.id);
}

function compareWorktreeLastUsedDesc(a: ReusableExecutionWorktreeLike, b: ReusableExecutionWorktreeLike) {
  const timeCompare = worktreeLastUsedTime(b) - worktreeLastUsedTime(a);
  if (timeCompare !== 0) return timeCompare;
  return compareWorktreeNames(a, b);
}

/**
 * The option subtitle. It used to fall back to the workspace working directory,
 * a path on the execution host, which the reuse-existing picker then rendered
 * next to a label that no longer shows one. The fallback is now the short id,
 * so the picker never renders a host path. `workspaceSearchText` still indexes
 * the working directory, so a user who already knows a path can search by it.
 */
function worktreeDescription(workspace: ReusableExecutionWorktreeLike) {
  return workspace.branchName ?? workspace.id.slice(0, 8);
}

function worktreeSearchText(workspace: ReusableExecutionWorktreeLike) {
  return [
    workspace.name,
    workspace.status,
    workspace.branchName,
    workspace.cwd,
    workspace.id,
  ].filter(Boolean).join(" ");
}

export function dedupeReusableExecutionWorktrees<T extends ReusableExecutionWorktreeLike>(
  worktrees: readonly T[],
): T[] {
  const deduplicatedByPath = new Map<string, T>();

  for (const worktree of worktrees) {
    const key = worktree.cwd ?? worktree.id;
    const existing = deduplicatedByPath.get(key);
    if (!existing || worktreeLastUsedTime(worktree) > worktreeLastUsedTime(existing)) {
      deduplicatedByPath.set(key, worktree);
    }
  }

  return Array.from(deduplicatedByPath.values());
}

export function orderReusableExecutionWorktrees<T extends ReusableExecutionWorktreeLike>(
  worktrees: readonly T[],
): T[] {
  const alphabetized = dedupeReusableExecutionWorktrees(worktrees).sort(compareWorktreeNames);
  if (alphabetized.length <= 1) return alphabetized;

  let mostRecentlyUsed = alphabetized[0]!;
  for (const worktree of alphabetized.slice(1)) {
    if (worktreeLastUsedTime(worktree) > worktreeLastUsedTime(mostRecentlyUsed)) {
      mostRecentlyUsed = worktree;
    }
  }

  return [
    mostRecentlyUsed,
    ...alphabetized.filter((worktree) => worktree.id !== mostRecentlyUsed.id),
  ];
}

export function buildReusableExecutionWorktreeOptionGroups<T extends ReusableExecutionWorktreeLike>(
  worktrees: readonly T[],
  options: { now?: Date | string; recentCutoffDays?: number } = {},
): ReusableWorktreeOptionGroup<T>[] {
  const nowTime = options.now ? new Date(options.now).getTime() : Date.now();
  const cutoffDays = options.recentCutoffDays ?? RECENT_WORKSPACE_CUTOFF_DAYS;
  const cutoffTime = nowTime - cutoffDays * 24 * 60 * 60 * 1000;
  const deduplicated = dedupeReusableExecutionWorktrees(worktrees);

  const toOption = (
    workspace: T,
    groupId: ReusableWorktreeOptionGroupId,
  ): ReusableWorktreeOption<T> => ({
    key: `${groupId}:${workspace.id}`,
    value: workspace.id,
    workspaceId: workspace.id,
    groupId,
    label: workspace.name,
    description: worktreeDescription(workspace),
    searchText: worktreeSearchText(workspace),
    workspace,
  });

  const recent = deduplicated
    .filter((worktree) => worktreeLastUsedTime(worktree) >= cutoffTime)
    .sort(compareWorktreeLastUsedDesc)
    .map((worktree) => toOption(worktree, "recent"));

  const all = [...deduplicated]
    .sort(compareWorktreeNames)
    .map((worktree) => toOption(worktree, "all"));

  return [
    ...(recent.length > 0 ? [{ id: "recent" as const, label: "Recent", options: recent }] : []),
    { id: "all", label: "All worktrees", options: all },
  ];
}

export function reusableWorktreeOptionMatches(
  option: Pick<ReusableWorktreeOption, "label" | "description" | "searchText">,
  query: string,
) {
  return scoreReusableWorktreeOptionMatch(option, query) !== null;
}

export function scoreReusableWorktreeOptionMatch(
  option: Pick<ReusableWorktreeOption, "label" | "description" | "searchText">,
  query: string,
) {
  return scoreFuzzyTextFields([
    { text: option.label, weight: 0 },
    { text: option.description, weight: 20 },
    { text: option.searchText, weight: 40 },
  ], query);
}
