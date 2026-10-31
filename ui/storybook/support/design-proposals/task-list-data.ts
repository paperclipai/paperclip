import type { Issue } from "@paperclipai/shared";
import type { TaskListItem } from "@/components/TaskList";
import type { TaskListColumnId } from "@/lib/task-list";
import { createIssue, storybookAgentMap, storybookExecutionWorkspaces, storybookIssueLabels } from "../../fixtures/paperclipData";

export const longTitle = "Document connector recovery behavior when an expired credential interrupts an active task and requires a human to reconnect the account";

export function task(number: number, title: string, status: Issue["status"], parentId: string | null = null): Issue {
  return createIssue({
    id: `row-design-${number}`,
    identifier: `PAP-${number}`,
    issueNumber: number,
    title,
    status,
    parentId,
    labelIds: [],
    labels: [],
    checkoutRunId: null,
    executionRunId: null,
    executionLockedAt: null,
    createdAt: new Date("2026-10-14T16:00:00Z"),
    updatedAt: new Date(Date.UTC(2026, 9, 14, 17, 0, number % 60)),
    lastActivityAt: new Date("2026-10-14T17:00:00Z"),
  });
}

export const connectorParent = task(428, "Improve connector reliability", "in_progress");
export const healthTask = task(429, "Define connector health states", "in_review", connectorParent.id);
export const recoveryParent = task(430, "Design reconnect and recovery flows", "todo", connectorParent.id);
export const recoveryChild = task(431, longTitle, "todo", recoveryParent.id);
export const recoverySibling = task(432, "Review failure messages with the team", "done", connectorParent.id);
export const chatTask = task(454, "Chat style tasks v2", "done");
export const emptyTask = task(455, "Refine the empty task-list state", "backlog");
export const readTask = task(456, "Review the connector experience", "todo");
export const unreadTask = task(457, "Define connector health states", "todo");

export const treeTasks = [connectorParent, healthTask, recoveryParent, recoveryChild, recoverySibling, chatTask, emptyTask];
export const ownerFor = (issue: Issue) => [429, 430, 432, 455].includes(issue.issueNumber ?? 0) ? "Design" : "Codex";

export function columnData(issue: Issue, owner: string) {
  const agent = storybookAgentMap.get("agent-codex")!;
  const labels = issue.status === "backlog" ? [] : storybookIssueLabels.slice(0, issue.status === "in_review" ? 2 : 1);
  const branch = issue.status === "backlog" ? null : `codex/pap-${issue.issueNumber}`;
  const rowIssue = {
    ...issue,
    createdByAgentId: issue.parentId ? agent.id : null,
    createdByUserId: issue.parentId ? null : "user-board",
    assigneeAgentId: issue.status !== "backlog" && owner === "Codex" ? agent.id : null,
    assigneeUserId: issue.status !== "backlog" && owner === "Design" ? "user-design" : null,
    labels,
    labelIds: labels.map(label => label.id),
    project: issue.status === "backlog" ? null : issue.project,
    projectId: issue.status === "backlog" ? null : issue.projectId,
    executionWorkspaceId: branch ? `worktree-${issue.id}` : null,
    currentExecutionWorkspace: branch ? { ...storybookExecutionWorkspaces[0]!, id: `worktree-${issue.id}`, sourceIssueId: issue.id, branchName: branch } : null,
  };
  return {
    issue: rowIssue,
    parent: treeTasks.find(candidate => candidate.id === issue.parentId),
    creator: rowIssue.createdByAgentId ? agent.name : "Scott",
    assignee: rowIssue.assigneeAgentId ? agent.name : rowIssue.assigneeUserId ? "Design" : null,
  };
}

export function sortValue(issue: Issue, column: TaskListColumnId) {
  const data = columnData(issue, ownerFor(issue));
  switch (column) {
    case "task": return issue.title;
    case "taskId": return issue.identifier;
    case "createdBy": return data.creator;
    case "assignee": return data.assignee;
    case "project": return data.issue.project?.name;
    case "parentTask": return data.parent ? `${data.parent.identifier} ${data.parent.title}` : null;
    case "tags": return data.issue.labels.map(label => label.name).sort().join(", ");
    case "lastUpdated": return new Date(issue.updatedAt).getTime();
    case "worktree": return data.issue.currentExecutionWorkspace?.branchName;
  }
}

export const reviewTaskItems: TaskListItem[] = treeTasks.map(issue => {
  const data = columnData(issue, ownerFor(issue));
  return { issue: data.issue, createdBy: data.creator, assignee: data.assignee, unread: issue === connectorParent || issue === healthTask };
});
