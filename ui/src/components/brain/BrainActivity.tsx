import { useQuery } from "@tanstack/react-query";
import { Activity, Moon, RefreshCw, Loader2 } from "lucide-react";
import { brainApi } from "@/api/brain";
import { queryKeys } from "@/lib/queryKeys";
import { EntityTypeBadge } from "./EntityTypeBadge";
import { timeAgo } from "@/lib/timeAgo";
import { cn } from "@/lib/utils";

interface BrainActivityProps {
  companyId: string;
  onSelectEntity?: (slug: string) => void;
}

const ACTION_COLORS: Record<string, string> = {
  created: "text-green-600 dark:text-green-400",
  updated: "text-blue-600 dark:text-blue-400",
  linked: "text-purple-600 dark:text-purple-400",
  enriched: "text-amber-600 dark:text-amber-400",
  deleted: "text-red-600 dark:text-red-400",
};

export function BrainActivity({ companyId, onSelectEntity }: BrainActivityProps) {
  const { data: activity, isLoading, refetch, isFetching } = useQuery({
    queryKey: queryKeys.brain.activity(companyId),
    queryFn: () => brainApi.getActivity(companyId, { limit: 100 }),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  const { data: dreamStatus } = useQuery({
    queryKey: queryKeys.brain.dreamStatus(companyId),
    queryFn: () => brainApi.getDreamStatus(companyId),
    enabled: !!companyId,
  });

  const { data: stats } = useQuery({
    queryKey: queryKeys.brain.stats(companyId),
    queryFn: () => brainApi.getStats(companyId),
    enabled: !!companyId,
  });

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4 shrink-0">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Total Pages</p>
          <p className="text-xl font-semibold tabular-nums">{stats?.totalPages ?? "-"}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Total Links</p>
          <p className="text-xl font-semibold tabular-nums">{stats?.totalLinks ?? "-"}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Orphans</p>
          <p className="text-xl font-semibold tabular-nums">{stats?.orphanCount ?? "-"}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-1.5">
            <Moon className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Dream Cycle</p>
          </div>
          {dreamStatus ? (
            <div className="mt-1">
              <p className="text-sm font-medium">
                {dreamStatus.lastRun ? timeAgo(dreamStatus.lastRun) : "Never run"}
              </p>
              <p className="text-xs text-muted-foreground">
                {dreamStatus.pagesProcessed} processed &middot; {dreamStatus.entitiesEnriched} enriched
              </p>
            </div>
          ) : (
            <p className="text-sm font-medium mt-1">-</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pb-2 shrink-0">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Recent Activity
        </h3>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!isLoading && (!activity || activity.length === 0) && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Activity className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No brain activity yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Activity will appear here as agents read and write to the brain
            </p>
          </div>
        )}

        {activity && activity.length > 0 && (
          <div className="border border-border divide-y divide-border">
            {activity.map((event) => (
              <button
                key={event.id}
                onClick={() => onSelectEntity?.(event.entitySlug)}
                className="flex items-start gap-3 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={cn("text-xs font-medium capitalize", ACTION_COLORS[event.action] ?? "text-foreground")}>
                      {event.action}
                    </span>
                    <EntityTypeBadge type={event.entityType} />
                  </div>
                  <p className="text-sm truncate">{event.summary}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span>{event.agentName}</span>
                    <span>&middot;</span>
                    <span>{timeAgo(event.timestamp)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
