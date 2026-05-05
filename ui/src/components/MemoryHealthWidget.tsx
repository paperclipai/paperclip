import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { Brain, RefreshCw } from "lucide-react";
import { ApiError } from "../api/client";
import { agentsApi } from "../api/agents";
import { instanceMemoryApi } from "../api/instanceMemory";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";

const pillClass = {
  green: "bg-emerald-500/15 text-emerald-300",
  yellow: "bg-amber-500/15 text-amber-300",
  red: "bg-red-500/15 text-red-300",
} as const;

function truncateActorId(actorId: string): string {
  if (actorId === "<unattributed>") return "Unattributed";
  return actorId.length > 8 ? `${actorId.slice(0, 8)}...` : actorId;
}

function getActorLabel(actorId: string, agentMap: Map<string, Agent>): string {
  const agent = agentMap.get(actorId);
  return agent?.name ?? truncateActorId(actorId);
}

export function MemoryHealthWidget() {
  const { selectedCompanyId } = useCompany();

  const {
    data,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: queryKeys.instanceMemoryHealth(),
    queryFn: instanceMemoryApi.health,
    staleTime: Infinity,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const isBoardAccessError = error instanceof ApiError && error.status === 403;
  const pill = data?.pill ?? (error ? "red" : "yellow");
  const statusReason = data?.reason ?? (error ? error.message : "Loading");

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 text-muted-foreground">
        <Brain className="h-4 w-4" />
        <h3 className="text-sm font-semibold uppercase tracking-wide">
          Memory Health
        </h3>
        <span className={cn("ml-auto rounded-full px-2 py-0.5 text-xs font-medium uppercase", pillClass[pill])}>
          {pill}
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          aria-label="Refresh memory health"
          title="Refresh memory health"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {isBoardAccessError ? (
        <div className="border border-border rounded-md p-4 text-sm text-muted-foreground">
          Board access required
        </div>
      ) : error && !data ? (
        <div className="border border-border rounded-md p-4 text-sm text-red-300">
          {error.message}
        </div>
      ) : (
        <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
          <div className="px-3 py-2.5 flex items-center justify-between gap-3 text-sm">
            <div className="flex items-center gap-2 min-w-0">
              <span className={cn("h-2 w-2 rounded-full", data?.shim.up ? "bg-emerald-400" : "bg-red-400")} />
              <span className="font-medium text-foreground">mem0-shim</span>
            </div>
            <span className="text-xs text-muted-foreground text-right">
              {data?.shim.up ? "up" : `down${data?.shim.error ? ` (${data.shim.error})` : ""}`}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-border">
            <div className="px-3 py-2.5">
              <p className="text-xs text-muted-foreground">total24h</p>
              <p className="mt-1 text-sm font-mono text-foreground">{data?.stats?.total24h ?? "-"}</p>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-xs text-muted-foreground">distinctActors24h</p>
              <p className="mt-1 text-sm font-mono text-foreground">{data?.stats?.distinctActors24h ?? "-"}</p>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-xs text-muted-foreground">lastWriteAt</p>
              <p className="mt-1 text-sm font-mono text-foreground">
                {data?.stats?.lastWriteAt ? timeAgo(data.stats.lastWriteAt) : "-"}
              </p>
            </div>
            <div className="px-3 py-2.5">
              <p className="text-xs text-muted-foreground">reason</p>
              <p className="mt-1 text-sm text-foreground truncate" title={statusReason}>
                {data?.pill === "green" ? "Healthy" : statusReason}
              </p>
            </div>
          </div>

          {(data?.stats?.topActors.length ?? 0) === 0 ? (
            <div className="px-3 py-2.5 text-sm text-muted-foreground">
              No actor writes in the last 24h.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {data?.stats?.topActors.map((actor) => (
                <div
                  key={actor.actorId}
                  className="px-3 py-2.5 flex items-center justify-between gap-3 text-sm hover:bg-accent/40 transition-colors"
                >
                  <span className="font-medium text-foreground truncate">
                    {getActorLabel(actor.actorId, agentMap)}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground shrink-0">{actor.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
