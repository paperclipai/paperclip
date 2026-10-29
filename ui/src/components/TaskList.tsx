import { Fragment, useState, type ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { buildIssueTree } from "../lib/issue-tree";
import { issueFilterLabel } from "../lib/issue-filters";
import { allTaskListColumns, defaultTaskListColumns, defaultTaskListSort, sortTaskListItems, type TaskListColumnId, type TaskListSort } from "../lib/task-list";
import { timeAgo } from "../lib/timeAgo";
import { IssueRow, type IssueRowDensity } from "./IssueRow";
import { IssueGroupHeader } from "./IssueGroupHeader";
import { TaskListColumnHeader, TaskListColumnSettings, TaskListViewport } from "./TaskListColumns";
import { TaskRowGroup } from "./TaskRowGroup";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

export type TaskListItem = {
  issue: Issue;
  unread?: boolean;
  createdBy?: string | null;
  assignee?: string | null;
};

export type TaskListGrouping = "none" | "status" | "project";

/** Keep matching subtasks in their hierarchy without pulling in unrelated siblings. */
export function includeTaskListAncestors(items: readonly TaskListItem[], matches: readonly TaskListItem[]): TaskListItem[] {
  const byId = new Map(items.map(item => [item.issue.id, item]));
  const included = new Set<string>();
  for (const match of matches) {
    let item: TaskListItem | undefined = match;
    while (item && !included.has(item.issue.id)) {
      included.add(item.issue.id);
      item = item.issue.parentId ? byId.get(item.issue.parentId) : undefined;
    }
  }
  return items.filter(item => included.has(item.issue.id));
}

/** Opt-in collection built from the reviewed row, hierarchy and column primitives. */
export function TaskList({ items, allItems = items, initialColumns = defaultTaskListColumns, density = "comfortable", collapsedIds, onCollapsedIdsChange, groupBy = "none", emptyState, issueLinkState }: {
  items: readonly TaskListItem[];
  allItems?: readonly TaskListItem[];
  initialColumns?: readonly TaskListColumnId[];
  density?: IssueRowDensity;
  collapsedIds?: ReadonlySet<string>;
  onCollapsedIdsChange?: (ids: ReadonlySet<string>) => void;
  groupBy?: TaskListGrouping;
  emptyState?: ReactNode;
  issueLinkState?: unknown;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [columnOrder, setColumnOrder] = useState(allTaskListColumns);
  const [sort, setSort] = useState<TaskListSort>();
  const [localCollapsed, setLocalCollapsed] = useState<ReadonlySet<string>>(new Set());
  const collapsed = collapsedIds ?? localCollapsed;
  const setCollapsed = onCollapsedIdsChange ?? setLocalCollapsed;
  const byId = new Map(allItems.map(item => [item.issue.id, item]));
  const visibleById = new Map(items.map(item => [item.issue.id, item]));
  const sortValue = (issue: Issue, column: TaskListColumnId) => {
    const item = byId.get(issue.id)!;
    const parent = issue.parentId ? byId.get(issue.parentId)?.issue : null;
    switch (column) {
      case "task": return issue.title;
      case "taskId": return issue.identifier;
      case "createdBy": return item.createdBy;
      case "assignee": return item.assignee;
      case "project": return issue.project?.name;
      case "parentTask": return parent ? `${parent.identifier} ${parent.title}` : null;
      case "tags": return issue.labels?.map(label => label.name).sort().join(", ");
      case "worktree": return issue.currentExecutionWorkspace?.branchName;
      case "lastUpdated": return new Date(issue.updatedAt).getTime();
    }
  };
  const { roots, childMap } = buildIssueTree(sortTaskListItems(items.map(item => item.issue), sort ?? defaultTaskListSort, sortValue));
  const updateColumns = (next: readonly TaskListColumnId[]) => {
    setColumns(next);
    if (sort && !next.includes(sort.column)) setSort(undefined);
  };
  const renderBranch = (issue: Issue, depth: number): ReactNode => {
    const item = visibleById.get(issue.id)!;
    const children = childMap.get(issue.id) ?? [];
    const expanded = !collapsed.has(issue.id);
    const parent = issue.parentId ? byId.get(issue.parentId)?.issue : null;
    const branch = issue.currentExecutionWorkspace?.branchName;
    return (
      <Fragment key={issue.id}>
        <IssueRow
          issue={issue} presentation="task" appearance="refreshed" density={density} issueLinkState={issueLinkState}
          unreadState={item.unread ? "visible" : "hidden"}
          treeGuides={depth} chevronInGuide={depth > 0 && children.length > 0}
          leadingControl={children.length ? (
            <Button variant="ghost" size="icon-xs" className="task-row-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${issue.title}`} aria-expanded={expanded} onClick={() => {
              const next = new Set(collapsed);
              if (next.has(issue.id)) next.delete(issue.id); else next.add(issue.id);
              setCollapsed(next);
            }}>{expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}</Button>
          ) : undefined}
          columnValues={{
            createdBy: item.createdBy,
            assignee: item.assignee ?? "Unassigned",
            project: issue.project?.name,
            parentTask: parent ? <span><span className="font-mono">{parent.identifier}</span> {parent.title}</span> : undefined,
            tags: issue.labels?.length ? <span className="inline-flex items-center gap-1">{issue.labels.map(label => <Badge key={label.id} variant="secondary" className="shrink-0 px-1.5 py-0">{label.name}</Badge>)}</span> : undefined,
            worktree: branch ? <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3 shrink-0" aria-hidden />{branch}</span> : undefined,
            lastUpdated: timeAgo(issue.updatedAt),
          }}
        />
        {expanded ? children.map(child => renderBranch(child, depth + 1)) : null}
      </Fragment>
    );
  };
  const groups = new Map<string, Issue[]>();
  for (const root of roots) {
    const label = groupBy === "status" ? issueFilterLabel(root.status) : groupBy === "project" ? root.project?.name ?? "No project" : "";
    groups.set(label, [...(groups.get(label) ?? []), root]);
  }
  return (
    <TaskListViewport visibleColumns={columns} columnOrder={columnOrder} controls={<TaskListColumnSettings visibleColumns={columns} onVisibleColumnsChange={updateColumns} onColumnOrderChange={setColumnOrder} onResetDefaults={() => setSort(undefined)} />}>
      <TaskListColumnHeader sort={sort} onSortChange={setSort} onColumnOrderChange={setColumnOrder} />
      {items.length === 0 ? emptyState : (
        <div aria-label={`${density} task list`}>
          {[...groups].map(([label, groupRoots]) => (
            <Fragment key={label}>
              {label ? <IssueGroupHeader label={label} className="task-list-group-heading" trailing={<span className="text-xs text-muted-foreground">{groupRoots.length}</span>} /> : null}
              {groupRoots.map(issue => <TaskRowGroup key={issue.id} role="rowgroup" aria-label={`${issue.title} task group`}>{renderBranch(issue, 0)}</TaskRowGroup>)}
            </Fragment>
          ))}
        </div>
      )}
    </TaskListViewport>
  );
}
