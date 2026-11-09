import type { TaskListItem } from "@/components/TaskList";
import { columnData, reviewTaskItems, task } from "./task-list-data";

const extraTasks: TaskListItem[] = [
  task(458, "Simplify the first company setup", "in_progress"),
  task(459, "Review budget notifications", "in_review"),
  task(460, "Collect feedback on the refreshed task list", "todo"),
].map((issue, index) => {
  const data = columnData(issue, index === 2 ? "Design" : "Codex");
  return { issue: data.issue, createdBy: data.creator, assignee: data.assignee, unread: index === 0 };
});
export const initialItems = [...reviewTaskItems, ...extraTasks];
export const recentTasks = [...initialItems]
  .filter(item => !item.issue.parentId)
  .sort((left, right) => new Date(right.issue.updatedAt).getTime() - new Date(left.issue.updatedAt).getTime())
  .slice(0, 5);
