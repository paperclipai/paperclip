import { Link } from "@/lib/router";
import { cn } from "../../lib/utils";
import { ChartCard, PriorityChart, IssueStatusChart } from "../ActivityCharts";
import type { Issue } from "@ironworksai/shared";

interface GoalProgress {
  goalId: string;
  title: string;
  status: string;
  progressPercent: number;
  completedIssues: number;
  totalIssues: number;
  blockedIssues: number;
}

export function ProgressSection({
  activeGoals,
  issues,
}: {
  activeGoals: GoalProgress[];
  issues: Issue[];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Goals Progress */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goals Progress</h4>
          <Link to="/goals" className="text-xs text-muted-foreground hover:text-foreground transition-colors">View all</Link>
        </div>
        {activeGoals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active goals.</p>
        ) : (
          <div className="space-y-4">
            {activeGoals.slice(0, 5).map((goal) => (
              <Link key={goal.goalId} to={`/goals/${goal.goalId}`} className="block space-y-1.5 no-underline text-inherit hover:opacity-80 transition-opacity">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate font-medium">{goal.title}</span>
                  <span className="text-sm text-muted-foreground shrink-0 ml-2">{goal.progressPercent}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full transition-[width] duration-300",
                      goal.progressPercent === 100 ? "bg-emerald-500" : goal.blockedIssues > 0 ? "bg-amber-500" : "bg-blue-500",
                    )}
                    style={{ width: `${goal.progressPercent}%` }}
                  />
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{goal.completedIssues}/{goal.totalIssues} done</span>
                  {goal.blockedIssues > 0 && (
                    <span className="text-amber-400">- {goal.blockedIssues} blocked</span>
                  )}
                  {goal.blockedIssues === 0 && goal.progressPercent < 100 && (
                    <span className="text-emerald-400">- on track</span>
                  )}
                  {goal.progressPercent === 100 && (
                    <span className="text-emerald-400">- complete</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Issues Overview */}
      <div className="rounded-xl border border-border p-4 space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Missions Overview</h4>
        <ChartCard title="Missions by Priority" subtitle="Last 14 days">
          <PriorityChart issues={issues} />
        </ChartCard>
        <ChartCard title="Missions by Status" subtitle="Last 14 days">
          <IssueStatusChart issues={issues} />
        </ChartCard>
      </div>
    </div>
  );
}
