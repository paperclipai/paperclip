import type { Issue, IssueStatus } from "@paperclipai/shared";
import type {
  IssueOverview,
  IssueOverviewPullRequest,
  IssueOverviewRef,
} from "@paperclipai/shared";

/**
 * Board-only projection of the shared issue-overview contract onto kanban
 * rendering. The canonical overview types + `useIssueOverviews` hook are
 * owned by the Data worker (`packages/shared/src/types/issue-overview.ts`,
 * `ui/src/hooks/useIssueOverviews.ts`); this module only derives
 * board-local display models from them, with honest Issue-field fallbacks
 * while overviews are pending, errored, or missing.
 */

/** Board lane sequence. `blocked` is intentionally excluded board-only. */
export type KanbanPhase = Exclude<IssueStatus, "blocked">;

export type KanbanBoardScope = "all" | "outcomes";

export interface KanbanProjectRef {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface KanbanBlockerModel {
  message: string | null;
  ownerLabel: string | null;
  nextAction: string | null;
  issues: IssueOverviewRef[];
}

export interface KanbanChildSummary {
  refs: IssueOverviewRef[];
  childCount: number;
  completedChildCount: number;
}

/** Effective lane for a card. Null means "Stage not recorded", never a default lane. */
export function resolveCardPhase(
  issue: Issue,
  overview: IssueOverview | undefined,
): KanbanPhase | null {
  if (overview) return overview.phase;
  return issue.status === "blocked" ? null : issue.status;
}

export function isCardBlocked(issue: Issue, overview: IssueOverview | undefined): boolean {
  if (overview) return overview.blocked;
  return issue.status === "blocked";
}

export function resolveCardProject(
  issue: Issue,
  overview: IssueOverview | undefined,
  projectsById: ReadonlyMap<string, KanbanProjectRef>,
): KanbanProjectRef | null {
  if (overview?.project) {
    return {
      id: overview.project.id,
      name: overview.project.name,
      color: overview.project.color,
    };
  }
  if (issue.projectId) return projectsById.get(issue.projectId) ?? null;
  return null;
}

/** Named parent when the server could resolve one; null covers "no parent". */
export function resolveParentRef(
  overview: IssueOverview | undefined,
): IssueOverviewRef | null {
  return overview?.parent ?? null;
}

export function resolveBlockerModel(
  issue: Issue,
  overview: IssueOverview | undefined,
): KanbanBlockerModel | null {
  if (overview?.blocker) return overview.blocker;
  const refs: IssueOverviewRef[] = (issue.blockedBy ?? []).map((blocker) => ({
    id: blocker.id,
    identifier: blocker.identifier,
    title: blocker.title,
    status: blocker.status,
  }));
  if (refs.length === 0) return null;
  return { message: null, ownerLabel: null, nextAction: null, issues: refs };
}

export function resolveChildSummary(
  issue: Issue,
  overview: IssueOverview | undefined,
  childIssues: Issue[],
): KanbanChildSummary {
  if (overview) {
    return {
      refs: overview.children,
      childCount: overview.childCount,
      completedChildCount: overview.completedChildCount,
    };
  }
  const refs: IssueOverviewRef[] = childIssues.map((child) => ({
    id: child.id,
    identifier: child.identifier,
    title: child.title,
    status: child.status,
  }));
  return {
    refs,
    childCount: refs.length,
    completedChildCount: childIssues.filter((child) => child.status === "done").length,
  };
}

export function resolveCardPullRequests(
  overview: IssueOverview | undefined,
): IssueOverviewPullRequest[] {
  return overview?.pullRequests ?? [];
}

/** Outcome scope shows family heads only; children stay reachable via expanders. */
export function isOutcomeRootIssue(issue: Issue, overview: IssueOverview | undefined): boolean {
  // A local parent link always wins: an unresolved overview parent must not
  // promote a known child to a family head.
  if (issue.parentId != null) return false;
  if (overview) return overview.parent == null;
  return true;
}

export function applyBoardScope(
  issues: Issue[],
  scope: KanbanBoardScope,
  overviewsById: ReadonlyMap<string, IssueOverview> | undefined,
): Issue[] {
  if (scope !== "outcomes") return issues;
  return issues.filter((issue) => isOutcomeRootIssue(issue, overviewsById?.get(issue.id)));
}

export function prStateLabel(state: IssueOverviewPullRequest["state"]): string {
  switch (state) {
    case "open":
      return "Open";
    case "draft":
      return "Draft";
    case "closed":
      return "Closed";
    case "merged":
      return "Merged";
    default:
      return "Unknown";
  }
}

/** Compact direct-link label: `repo#123`, `#123`, or bare `PR` when unknown. */
export function prDisplayRef(pr: IssueOverviewPullRequest): string {
  const number = pr.number != null ? `#${pr.number}` : "PR";
  return pr.repository ? `${pr.repository}${number}` : number;
}

export interface KanbanProjectGroup {
  key: string;
  projectId: string | null;
  label: string;
  color?: string | null;
  icon?: string | null;
  items: Issue[];
}

/** Project swimlane groups, alphabetical with "No project" last. */
export function groupIssuesByProject(
  issues: Issue[],
  resolveProject: (issue: Issue) => KanbanProjectRef | null,
): KanbanProjectGroup[] {
  const groups = new Map<string, KanbanProjectGroup>();
  for (const issue of issues) {
    const project = resolveProject(issue);
    const key = project?.id ?? "__none__";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        projectId: project?.id ?? null,
        label: project?.name ?? "No project",
        color: project?.color ?? null,
        icon: project?.icon ?? null,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(issue);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.projectId == null && b.projectId == null) return 0;
    if (a.projectId == null) return 1;
    if (b.projectId == null) return -1;
    return a.label.localeCompare(b.label);
  });
}
