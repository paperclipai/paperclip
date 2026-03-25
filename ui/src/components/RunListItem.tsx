import { Link } from "@/lib/router";
import { Clock } from "lucide-react";
import { cn, relativeTime, formatTokens } from "../lib/utils";
import { runStatusIcons, runMetrics, runSummary } from "../lib/run-utils";
import { invocationSourceLabel, invocationSourceBadge, invocationSourceBadgeDefault } from "../lib/status-colors";
import type { HeartbeatRun, Agent } from "@paperclipai/shared";

interface RunListItemProps {
  run: HeartbeatRun;
  isSelected: boolean;
  /** Route prefix for the link, e.g. `/agents/alpha` or `/runs` */
  linkTo: string;
  /** Deselect link — where clicking the selected item navigates to */
  deselectTo?: string;
  agentName?: string;
}

export function RunListItem({ run, isSelected, linkTo, deselectTo, agentName }: RunListItemProps) {
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = runSummary(run);

  const href = isSelected && deselectTo ? deselectTo : linkTo;

  return (
    <Link
      to={href}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
          invocationSourceBadge[run.invocationSource] ?? invocationSourceBadgeDefault,
        )}>
          {invocationSourceLabel[run.invocationSource] ?? run.invocationSource}
        </span>
        {agentName && (
          <span className="text-[11px] font-medium text-foreground/70 truncate max-w-[120px]">
            {agentName}
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 80)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground tabular-nums">
          {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </Link>
  );
}
