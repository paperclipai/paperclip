import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder, FolderOpen } from "lucide-react";
import type { Issue, Project } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { RecentTaskNavItem } from "./RecentTaskNavItem";
import { TruncatedText } from "./TruncatedText";
import { StatusIcon } from "./StatusIcon";

export function SidebarProjectTasks({ project, userId, renderRow, className, renderTask }: {
  project: Pick<Project, "id" | "companyId" | "name">;
  userId?: string | null;
  renderRow: (toggle: ReactNode) => ReactNode;
  className?: string;
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
  const FolderIcon = expanded ? FolderOpen : Folder;
  return <div className="design-sidebar-primary">
    {renderRow(
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? contentId : undefined}
        onClick={() => setExpanded(previous => !previous)}
        className={cn("design-sidebar-item design-sidebar-project-toggle flex items-center gap-2.5 rounded-lg py-1.5 text-left font-medium focus-visible:outline-ring", className)}
      >
        <FolderIcon aria-hidden className="size-4 shrink-0" />
        <TruncatedText className="min-w-0 flex-1 truncate">{project.name}</TruncatedText>
      </button>
    )}
    {expanded && <div id={contentId} className="design-sidebar-primary ms-2">
      {isPending ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading tasks…</p>
        : error ? <p className="px-3 py-2 text-xs text-muted-foreground" role="alert">Couldn’t load tasks.</p>
          : tasks?.length ? tasks.map(task => <div key={task.id}>{renderTask ? renderTask(task)
            : <RecentTaskNavItem className="design-sidebar-item" task={task} label={task.title} iconNode={<StatusIcon {...taskStatusIconProps(task)} />} />}</div>)
            : <p className="px-3 py-2 text-xs text-muted-foreground">No tasks yet.</p>}
    </div>}
  </div>;
}
