import { CheckCircle2, Circle, Loader2, ShieldAlert } from "lucide-react";
import { cn } from "../../lib/utils";

interface GoalProgressStats {
  totalIssues: number;
  completedIssues: number;
  inProgressIssues: number;
  blockedIssues: number;
  todoIssues: number;
  progressPercent: number;
}

export function GoalProgressBar({ progress }: { progress: GoalProgressStats }) {
  if (progress.totalIssues === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Progress</span>
        <span className="font-medium">{progress.completedIssues}/{progress.totalIssues} missions done ({progress.progressPercent}%)</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            progress.progressPercent === 100 ? "bg-emerald-500" : progress.progressPercent > 50 ? "bg-blue-500" : "bg-amber-500",
          )}
          style={{ width: `${progress.progressPercent}%` }}
        />
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {progress.completedIssues > 0 && (
          <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" />{progress.completedIssues} done</span>
        )}
        {progress.inProgressIssues > 0 && (
          <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 text-blue-500" />{progress.inProgressIssues} active</span>
        )}
        {progress.blockedIssues > 0 && (
          <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3 text-red-500" />{progress.blockedIssues} blocked</span>
        )}
        {progress.todoIssues > 0 && (
          <span className="flex items-center gap-1"><Circle className="h-3 w-3" />{progress.todoIssues} pending</span>
        )}
      </div>
    </div>
  );
}
