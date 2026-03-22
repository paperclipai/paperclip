import { Link } from "@/lib/router";
import type { AgentWorkload } from "@paperclipai/shared";
import { cn } from "../lib/utils";

interface CapacityPanelProps {
  workload: AgentWorkload;
}

const CAPACITY_BADGE_CLASS: Record<AgentWorkload["capacityStatus"], string> = {
  GREEN: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  YELLOW: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  RED: "bg-red-500/10 text-red-700 dark:text-red-300",
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "No start time";
  if (seconds < 60) return "< 1m";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function engineerDotClass(taskCount: number): string {
  return taskCount === 0 ? "bg-emerald-500" : "bg-cyan-500";
}

export function CapacityPanel({ workload }: CapacityPanelProps) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Capacity
      </h3>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={cn("inline-flex rounded-full px-2 py-1 text-xs font-semibold", CAPACITY_BADGE_CLASS[workload.capacityStatus])}>
              {workload.capacityStatus}
            </span>
            <span className="text-sm text-muted-foreground">
              {workload.idleEngineers} idle · {workload.queuedTasks} queued
            </span>
          </div>
          <span className="text-xs text-muted-foreground">{workload.engineers.length} engineers</span>
        </div>

        {workload.engineers.length === 0 ? (
          <div className="px-4 py-5 text-sm text-muted-foreground">No operational engineers found.</div>
        ) : (
          <div className="divide-y divide-border">
            {workload.engineers.map((engineer) => {
              const primaryTask = engineer.currentTasks[0];
              return (
                <div key={engineer.agentId} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] md:items-center">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", engineerDotClass(engineer.currentTasks.length))} />
                    <Link to={`/agents/${engineer.urlKey}`} className="truncate text-sm font-medium hover:underline">
                      {engineer.name}
                    </Link>
                  </div>

                  <div className="min-w-0 text-sm text-muted-foreground">
                    {primaryTask ? (
                      <Link
                        to={`/issues/${primaryTask.identifier}`}
                        className="block truncate hover:text-foreground hover:underline"
                        title={`${primaryTask.identifier} - ${primaryTask.title}`}
                      >
                        {primaryTask.identifier} - {primaryTask.title}
                      </Link>
                    ) : (
                      <span className="text-emerald-600 dark:text-emerald-400">Available now</span>
                    )}
                  </div>

                  <div className="text-xs text-muted-foreground md:text-right">
                    {engineer.currentTasks.length > 0
                      ? `${engineer.currentTasks.length} active · ${formatDuration(engineer.timeInCurrentTaskSec)}`
                      : "Idle"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
