import type { Rt2TaskSummary } from "../api/rt2-tasks";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";

export function Rt2TaskList({
  companyId: _companyId,
  projectId: _projectId,
  tasks,
  onCreateTask,
}: {
  companyId: string;
  projectId: string;
  tasks: Rt2TaskSummary[];
  onCreateTask: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button variant="outline" size="sm" onClick={onCreateTask}>
          New Task
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {tasks.map((task) => (
          <Link
            key={task.issueId}
            to={`/issues/${task.issueId}`}
            className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{task.title}</h3>
              <span className="text-[11px] uppercase text-muted-foreground">{task.taskMode}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <span>{task.activeParticipantCount} / {task.capacity} participants</span>
              <span>{task.todoCount} todos</span>
              <span>{task.deliverableCount} deliverables</span>
              <span>{task.status.replaceAll("_", " ")}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
