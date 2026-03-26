import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  MessageSquare,
  Settings,
  Play,
  LayoutDashboard,
  FolderOpen,
  ExternalLink,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { Agent, ChatSession } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { agentsApi } from "../api/agents";
import { chatApi } from "../api/chat";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, relativeTime } from "../lib/utils";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { AgentIcon } from "../components/AgentIconPicker";
import { AgentChatSessionTab } from "../components/AgentChatSessionTab";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

function sortByHierarchy(agents: Agent[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const parent = a.reportsTo && byId.has(a.reportsTo) ? a.reportsTo : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const sorted: Agent[] = [];
  const queue = childrenOf.get(null) ?? [];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }
  return sorted;
}

function AgentListPanel({
  agents,
  liveCountByAgent,
  recentSessionsByAgent,
  selectedAgentId,
  onSelectAgent,
  searchQuery,
  onSearchChange,
  collapsed,
  onToggleCollapse,
}: {
  agents: Agent[];
  liveCountByAgent: Map<string, number>;
  recentSessionsByAgent: Map<string, ChatSession>;
  selectedAgentId: string | null;
  onSelectAgent: (agent: Agent) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.role && a.role.toLowerCase().includes(q)),
    );
  }, [agents, searchQuery]);

  return (
    <aside className="flex h-full flex-col border-r border-border bg-card/40">
      <div className="shrink-0 border-b border-border p-3">
        <div className={cn("flex items-center", collapsed ? "justify-center" : "mb-2 justify-between")}>
          <div className={cn("flex items-center gap-2", collapsed && "hidden")}>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <span
              className="text-sm font-semibold"
              style={{ fontFamily: "var(--font-family-display)" }}
            >
              Chat
            </span>
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title={collapsed ? "Expand agent list" : "Collapse agent list"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>
        {!collapsed && (
          <Input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 text-xs"
            placeholder="Search agents..."
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-auto-hide">
        {!collapsed && filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No agents found
          </div>
        )}
        {filtered.map((agent) => {
          const isSelected = agent.id === selectedAgentId;
          const runCount = liveCountByAgent.get(agent.id) ?? 0;
          const recentSession = recentSessionsByAgent.get(agent.id);
          const dotColor =
            agentStatusDot[agent.status] ?? agentStatusDotDefault;

          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelectAgent(agent)}
              title={collapsed ? agent.name : undefined}
              className={cn(
                "flex w-full items-start gap-3 text-left transition-colors",
                collapsed ? "justify-center px-0 py-2.5" : "px-3 py-3",
                isSelected
                  ? "bg-accent text-foreground"
                  : "text-foreground/80 hover:bg-accent/50",
              )}
            >
              <div className={cn("relative shrink-0", !collapsed && "mt-0.5")}>
                <AgentIcon
                  icon={agent.icon}
                  className="h-5 w-5 text-muted-foreground"
                />
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background",
                    dotColor,
                  )}
                />
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">
                      {agent.name}
                    </span>
                    {runCount > 0 && (
                      <span className="flex items-center gap-1 shrink-0">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="animate-pulse-amber absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
                        </span>
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {agent.role ? agent.role.replace(/_/g, " ") : "agent"}
                  </div>
                  {recentSession && (
                    <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
                      {relativeTime(
                        recentSession.lastMessageAt ?? recentSession.updatedAt,
                      )}
                    </div>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function AgentContextBar({ agent }: { agent: Agent }) {
  const ref = agentRouteRef(agent);

  return (
    <div className="flex items-center justify-between border-b border-border bg-background/95 px-4 py-2 backdrop-blur-sm">
      <div className="flex items-center gap-3 min-w-0">
        <AgentIcon
          icon={agent.icon}
          className="h-5 w-5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{agent.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {agent.title ?? (agent.role ? agent.role.replace(/_/g, " ") : "Agent")}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/agents/${ref}/dashboard`}>
            <LayoutDashboard className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/agents/${ref}/configuration`}>
            <Settings className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/agents/${ref}/runs`}>
            <Play className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/agents/${ref}/workspace`}>
            <FolderOpen className="h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link to={`/agents/${ref}`}>
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <MessageSquare className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
        <h3 className="text-sm font-medium text-foreground">
          Select an agent to chat
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick an agent from the list to start or continue a conversation.
        </p>
      </div>
    </div>
  );
}

export function Chat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const params = useParams<{ agentId?: string }>();

  const [agentSearch, setAgentSearch] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("chat-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("chat-sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const { data: companySessions = [] } = useQuery({
    queryKey: queryKeys.chatCompanySessions(selectedCompanyId!),
    queryFn: () => chatApi.listCompanySessions(selectedCompanyId!, { limit: 200 }),
    enabled: !!selectedCompanyId,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const recentSessionsByAgent = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of companySessions) {
      if (!map.has(session.agentId)) {
        map.set(session.agentId, session);
      }
    }
    return map;
  }, [companySessions]);

  const visibleAgents = useMemo(() => {
    const filtered = agents.filter((a: Agent) => a.status !== "terminated");
    const sorted = sortByHierarchy(filtered);

    const withActivity = new Set(recentSessionsByAgent.keys());
    const withLiveRuns = new Set(liveCountByAgent.keys());
    return sorted.sort((a, b) => {
      const aActive = withLiveRuns.has(a.id) ? 2 : withActivity.has(a.id) ? 1 : 0;
      const bActive = withLiveRuns.has(b.id) ? 2 : withActivity.has(b.id) ? 1 : 0;
      return bActive - aActive;
    });
  }, [agents, recentSessionsByAgent, liveCountByAgent]);

  const selectedAgent = useMemo(() => {
    if (!params.agentId) return null;
    return (
      agents.find(
        (a: Agent) =>
          a.id === params.agentId ||
          a.urlKey === params.agentId ||
          agentRouteRef(a) === params.agentId,
      ) ?? null
    );
  }, [agents, params.agentId]);

  const handleSelectAgent = (agent: Agent) => {
    navigate(`/chat/${agentRouteRef(agent)}`, { replace: true });
  };

  return (
    <div className="flex h-[calc(100vh-6.5rem)] min-h-[36rem] overflow-hidden rounded-lg border border-border bg-background">
      <div className={cn(
        "shrink-0 transition-[width] duration-200 ease-in-out",
        sidebarCollapsed ? "w-12" : "w-56 lg:w-64",
      )}>
        <AgentListPanel
          agents={visibleAgents}
          liveCountByAgent={liveCountByAgent}
          recentSessionsByAgent={recentSessionsByAgent}
          selectedAgentId={selectedAgent?.id ?? null}
          onSelectAgent={handleSelectAgent}
          searchQuery={agentSearch}
          onSearchChange={setAgentSearch}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selectedAgent ? (
          <>
            <AgentContextBar agent={selectedAgent} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <AgentChatSessionTab
                agentId={selectedAgent.id}
                agentRouteId={agentRouteRef(selectedAgent)}
                adapterType={selectedAgent.adapterType}
                agentName={selectedAgent.name}
                fillContainer
              />
            </div>
          </>
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}
