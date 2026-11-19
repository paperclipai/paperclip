import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import type { Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { RecentTaskNavItem } from "./RecentTaskNavItem";
import { StatusIcon } from "./StatusIcon";

export function SidebarProjectTasks({ project, userId, children, renderTask }: {
  project: Pick<Project, "id" | "companyId" | "name">;
  userId?: string | null;
  children: ReactNode;
  renderTask?: (task: Issue) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { data: tasks, isPending, error } = useQuery({
    queryKey: [...queryKeys.issues.listByProject(project.companyId, project.id), "sidebar-tasks", userId ?? "__local_board__"],
    queryFn: ({ signal }) => issuesApi.list(project.companyId, {
      projectId: project.id, includeReadState: true, limit: 12, sortField: "updated", sortDir: "desc",
    }, { signal }),
    enabled: expanded,
  });
  return <div>
    <div className="flex min-w-0 items-center">
      <div className="relative min-w-0 flex-1">{children}</div>
      <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded} aria-controls={contentId}
        className="mr-2 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded(previous => !previous)}>
        <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      </button>
    </div>
    {expanded && <div id={contentId} className="ml-5 border-l border-border pl-1">
      {isPending ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading tasks…</p>
        : error ? <p className="px-3 py-2 text-xs text-muted-foreground" role="alert">Couldn’t load tasks.</p>
          : tasks?.length ? tasks.map(task => <div key={task.id}>{renderTask ? renderTask(task)
            : <RecentTaskNavItem className="design-sidebar-item" task={task} label={task.title} iconNode={<StatusIcon {...taskStatusIconProps(task)} />} />}</div>)
            : <p className="px-3 py-2 text-xs text-muted-foreground">No tasks yet.</p>}
    </div>}
  </div>;
}
