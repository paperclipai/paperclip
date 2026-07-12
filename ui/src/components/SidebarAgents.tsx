import { useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

interface RunStats {
  running: number;
  queued: number;
  errored: number;
}

const EMPTY_RUN_STATS: RunStats = { running: 0, queued: 0, errored: 0 };

// Terminal failure statuses that count toward the red "errored" dot. Kept in
// sync with the server's FAILED_HEARTBEAT_STATUSES — the live-runs endpoint
// only appends these when includeRecentErrors is set.
const ERRORED_RUN_STATUSES = ["failed", "timed_out"];

const RUN_DOT_STYLES = {
  green: { dot: "bg-green-500", ping: "bg-green-400", text: "text-green-600 dark:text-green-400" },
  amber: { dot: "bg-amber-500", ping: "bg-amber-400", text: "text-amber-600 dark:text-amber-400" },
  red: { dot: "bg-red-500", ping: "bg-red-400", text: "text-red-600 dark:text-red-400" },
} as const;

function RunDot({
  color,
  count,
  pulse,
  label,
}: {
  color: keyof typeof RUN_DOT_STYLES;
  count: number;
  pulse?: boolean;
  label: string;
}) {
  const style = RUN_DOT_STYLES[color];
  return (
    <span className="flex items-center gap-1" title={label}>
      <span className="relative flex h-2 w-2">
        {pulse ? (
          <span
            className={cn(
              "animate-pulse absolute inline-flex h-full w-full rounded-full opacity-75",
              style.ping,
            )}
          />
        ) : null}
        <span className={cn("relative inline-flex rounded-full h-2 w-2", style.dot)} />
      </span>
      <span className={cn("text-[11px] font-medium tabular-nums", style.text)}>{count}</span>
    </span>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  // Distinct key from the plain live-runs consumers: this variant also carries
  // each agent's recently-errored latest run (for the red dot), which the other
  // consumers must not see as "live". Prefix-invalidation on the base key still
  // refreshes it via LiveUpdatesProvider.
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "withErrors"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, undefined, true),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const runStatsByAgent = useMemo(() => {
    const stats = new Map<string, RunStats>();
    for (const run of liveRuns ?? []) {
      const s = stats.get(run.agentId) ?? { running: 0, queued: 0, errored: 0 };
      if (run.status === "running") s.running += 1;
      else if (run.status === "queued") s.queued += 1;
      else if (ERRORED_RUN_STATUSES.includes(run.status)) s.errored += 1;
      stats.set(run.agentId, s);
    }
    return stats;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return filtered;
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;


  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New agent"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {orderedAgents.map((agent: Agent) => {
            const stats = runStatsByAgent.get(agent.id) ?? EMPTY_RUN_STATS;
            const hasRuns = stats.running > 0 || stats.queued > 0 || stats.errored > 0;
            return (
              <NavLink
                key={agent.id}
                to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
                  activeAgentId === agentRouteRef(agent)
                    ? "bg-accent text-foreground"
                    : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{agent.name}</span>
                {(agent.pauseReason === "budget" || hasRuns) && (
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {agent.pauseReason === "budget" ? (
                      <BudgetSidebarMarker title="Agent paused by budget" />
                    ) : null}
                    {stats.running > 0 ? (
                      <RunDot
                        color="green"
                        count={stats.running}
                        pulse
                        label={`${stats.running} running`}
                      />
                    ) : null}
                    {stats.queued > 0 ? (
                      <RunDot
                        color="amber"
                        count={stats.queued}
                        label={`${stats.queued} queued`}
                      />
                    ) : null}
                    {stats.errored > 0 ? (
                      <RunDot
                        color="red"
                        count={stats.errored}
                        label="Latest run errored recently"
                      />
                    ) : null}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
