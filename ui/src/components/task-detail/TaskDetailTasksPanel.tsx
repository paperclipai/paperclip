import type { ReactNode } from "react";
import type { Issue, Project } from "@paperclipai/shared";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { projectRouteRef } from "@/lib/utils";
import { issueStatusOrder } from "@/lib/issue-filters";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TaskDetailSubtasksPanel, TaskDetailTaskList } from "./TaskDetailRelationsPanel";

function TaskGroup({ name, projectPath, children }: { name: string; projectPath?: string; children: ReactNode }) {
  return (
    <Collapsible defaultOpen asChild>
      <section aria-label={name}>
        <div className="group/header flex items-center gap-1 rounded-md hover:bg-accent/50">
          <h2>
            <CollapsibleTrigger className="group flex items-center gap-1 rounded-md py-1 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>{name}</span>
              <span aria-hidden className="flex w-3.5 items-center justify-center opacity-0 transition-opacity duration-(--motion-duration-fast) ease-(--motion-ease-standard) group-hover/header:opacity-100 group-focus-within/header:opacity-100">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-(--motion-duration-fast) ease-(--motion-ease-standard) group-data-[state=open]:rotate-90" />
              </span>
            </CollapsibleTrigger>
          </h2>
          {projectPath && (
            <Link to={projectPath} aria-label={`Go to ${name} project`} title={`Go to ${name} project`} className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-(--motion-duration-fast) ease-(--motion-ease-standard) hover:bg-accent hover:text-foreground group-hover/header:opacity-100 group-focus-within/header:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
        <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export interface TaskDetailTasksPanelProps {
  subtasks: Issue[];
  createdTasks: Issue[];
  projects: Project[];
  isLoading?: boolean;
  hasError?: boolean;
  onRetry?: () => void;
  issueLinkState?: unknown;
}

export function TaskDetailTasksPanel({ subtasks, createdTasks, projects, isLoading, hasError, onRetry, issueLinkState }: TaskDetailTasksPanelProps) {
  const sortedSubtasks = sortTasks(subtasks);
  const groups = new Map<string, { name: string; path?: string; tasks: Issue[] }>();
  for (const item of sortTasks(createdTasks)) {
    const key = item.projectId ?? "no-project";
    const project = item.projectId
      ? projects.find((candidate) => candidate.id === item.projectId) ?? item.project
      : null;
    const group = groups.get(key) ?? {
      name: project?.name ?? (item.projectId ? "Project" : "No project"),
      path: item.projectId ? `/projects/${projectRouteRef(project ?? { id: item.projectId })}/issues` : undefined,
      tasks: [],
    };
    group.tasks.push(item);
    groups.set(key, group);
  }
  return (
    <section className="flex flex-col gap-6" aria-label="Related tasks">
      {sortedSubtasks.length > 0 && (
        <TaskGroup name="Subtasks">
          <TaskDetailSubtasksPanel items={sortedSubtasks} issueLinkState={issueLinkState} />
        </TaskGroup>
      )}
      {[...groups.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name)).map(([id, group]) => (
        <TaskGroup key={id} name={group.name} projectPath={group.path}>
          <TaskDetailTaskList items={group.tasks} ariaLabel={`${group.name} tasks`} issueLinkState={issueLinkState} />
        </TaskGroup>
      ))}
      {isLoading && <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p>}
      {hasError && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <span>Could not load all tasks.</span>
          {onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button>}
        </div>
      )}
      {!isLoading && !hasError && subtasks.length === 0 && createdTasks.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">No tasks yet.</p>
      )}
    </section>
  );
}

function sortTasks(items: Issue[]) {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) =>
    issueStatusOrder.indexOf(a.status) - issueStatusOrder.indexOf(b.status),
  );
}
