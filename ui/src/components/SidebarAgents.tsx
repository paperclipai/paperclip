import { useMemo, useState, useRef } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, FolderPlus, X, Pencil, Check } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi, agentGroupsApi, agentGroupMembershipApi } from "../api/agents";
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
import type { Agent, AgentGroup } from "@paperclipai/shared";
function AgentRow({
  agent,
  activeAgentId,
  activeTab,
  runCount,
  isMobile,
  setSidebarOpen,
  onDragStart,
  dragging,
}: {
  agent: Agent;
  activeAgentId: string | null;
  activeTab: string | null;
  runCount: number;
  isMobile: boolean;
  setSidebarOpen: (open: boolean) => void;
  onDragStart: (agentId: string) => void;
  dragging: boolean;
}) {
  return (
    <NavLink
      key={agent.id}
      to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(agent.id); }}
      className={cn(
        "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors cursor-grab active:cursor-grabbing",
        activeAgentId === agentRouteRef(agent)
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        dragging && "opacity-50",
      )}
    >
      <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
      <span className="flex-1 truncate">{agent.name}</span>
      {(agent.pauseReason === "budget" || runCount > 0) && (
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {agent.pauseReason === "budget" ? <BudgetSidebarMarker title="Agent paused by budget" /> : null}
          {runCount > 0 ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          ) : null}
          {runCount > 0 ? (
            <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{runCount} live</span>
          ) : null}
        </span>
      )}
    </NavLink>
  );
}

function GroupSection({
  group,
  agents,
  activeAgentId,
  activeTab,
  liveCountByAgent,
  isMobile,
  setSidebarOpen,
  draggingAgentId,
  onDragStart,
  onDrop,
  onRename,
  onDelete,
}: {
  group: AgentGroup;
  agents: Agent[];
  activeAgentId: string | null;
  activeTab: string | null;
  liveCountByAgent: Map<string, number>;
  isMobile: boolean;
  setSidebarOpen: (open: boolean) => void;
  draggingAgentId: string | null;
  onDragStart: (agentId: string) => void;
  onDrop: (groupId: string | null) => void;
  onRename: (groupId: string, name: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function commitRename() {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== group.name) onRename(group.id, trimmed);
    setEditing(false);
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); onDrop(group.id); }}
      className={cn("rounded transition-colors", dragOver && "bg-accent/30")}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="group flex items-center px-3 py-1 gap-1">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight className={cn("h-3 w-3 text-muted-foreground/50 transition-transform", open && "rotate-90")} />
            {editing ? (
              <input
                ref={inputRef}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setEditing(false); }}
                onBlur={commitRename}
                autoFocus
                className="text-[10px] font-medium uppercase tracking-widest font-mono bg-transparent border-none outline-none w-full text-muted-foreground/80"
              />
            ) : (
              <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60 truncate">
                {group.name}
              </span>
            )}
          </CollapsibleTrigger>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {editing ? (
              <button onClick={commitRename} className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors">
                <Check className="h-2.5 w-2.5" />
              </button>
            ) : (
              <button onClick={() => { setEditing(true); setEditName(group.name); }} className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors" aria-label="Rename group">
                <Pencil className="h-2.5 w-2.5" />
              </button>
            )}
            <button onClick={() => onDelete(group.id)} className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-destructive hover:bg-accent/50 transition-colors" aria-label="Delete group">
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
        <CollapsibleContent>
          <div className="flex flex-col gap-0.5 pl-2">
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                activeAgentId={activeAgentId}
                activeTab={activeTab}
                runCount={liveCountByAgent.get(agent.id) ?? 0}
                isMobile={isMobile}
                setSidebarOpen={setSidebarOpen}
                onDragStart={onDragStart}
                dragging={draggingAgentId === agent.id}
              />
            ))}
            {agents.length === 0 && (
              <div className="px-3 py-1 text-[11px] text-muted-foreground/40 italic">Drop agents here</div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [draggingAgentId, setDraggingAgentId] = useState<string | null>(null);
  const [ungroupedDragOver, setUngroupedDragOver] = useState(false);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: groups } = useQuery({
    queryKey: queryKeys.agentGroups.list(selectedCompanyId!),
    queryFn: () => agentGroupsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const createGroupMutation = useMutation({
    mutationFn: (name: string) => agentGroupsApi.create(selectedCompanyId!, { name, sortOrder: (groups ?? []).length }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentGroups.list(selectedCompanyId!) }),
  });
  const renameGroupMutation = useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      agentGroupsApi.update(selectedCompanyId!, groupId, { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agentGroups.list(selectedCompanyId!) }),
  });
  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => agentGroupsApi.delete(selectedCompanyId!, groupId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentGroups.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) });
    },
  });
  const assignGroupMutation = useMutation({
    mutationFn: ({ agentId, groupId }: { agentId: string; groupId: string | null }) =>
      agentGroupMembershipApi.assignAgent(agentId, groupId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(
    () => (agents ?? []).filter((a: Agent) => a.status !== "terminated"),
    [agents],
  );
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({ agents: visibleAgents, companyId: selectedCompanyId, userId: currentUserId });

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  const groupedAgents = useMemo(() => {
    const byGroup = new Map<string, Agent[]>();
    const ungrouped: Agent[] = [];
    for (const agent of orderedAgents) {
      if (agent.groupId) {
        const list = byGroup.get(agent.groupId) ?? [];
        list.push(agent);
        byGroup.set(agent.groupId, list);
      } else {
        ungrouped.push(agent);
      }
    }
    return { byGroup, ungrouped };
  }, [orderedAgents]);

  function handleDrop(groupId: string | null) {
    if (!draggingAgentId) return;
    assignGroupMutation.mutate({ agentId: draggingAgentId, groupId });
    setDraggingAgentId(null);
  }

  function submitNewGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    createGroupMutation.mutate(name);
    setNewGroupName("");
    setCreatingGroup(false);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight className={cn("h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100", open && "rotate-90")} />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">Agents</span>
          </CollapsibleTrigger>
          <div className="flex items-center gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); setCreatingGroup(true); }}
              className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
              aria-label="New group"
            >
              <FolderPlus className="h-3 w-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); openNewAgent(); }}
              className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
              aria-label="New agent"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {/* New group input */}
          {creatingGroup && (
            <div className="flex items-center gap-1 px-3 py-1">
              <input
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitNewGroup(); if (e.key === "Escape") setCreatingGroup(false); }}
                onBlur={() => { if (!newGroupName.trim()) setCreatingGroup(false); }}
                placeholder="Group name..."
                className="flex-1 text-[12px] bg-transparent border-b border-border outline-none text-foreground placeholder:text-muted-foreground/40"
              />
              <button onClick={submitNewGroup} className="text-muted-foreground/60 hover:text-foreground"><Check className="h-3 w-3" /></button>
              <button onClick={() => setCreatingGroup(false)} className="text-muted-foreground/60 hover:text-foreground"><X className="h-3 w-3" /></button>
            </div>
          )}

          {/* Groups */}
          {(groups ?? []).map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              agents={groupedAgents.byGroup.get(group.id) ?? []}
              activeAgentId={activeAgentId}
              activeTab={activeTab}
              liveCountByAgent={liveCountByAgent}
              isMobile={isMobile}
              setSidebarOpen={setSidebarOpen}
              draggingAgentId={draggingAgentId}
              onDragStart={setDraggingAgentId}
              onDrop={handleDrop}
              onRename={(groupId, name) => renameGroupMutation.mutate({ groupId, name })}
              onDelete={(groupId) => deleteGroupMutation.mutate(groupId)}
            />
          ))}

          {/* Ungrouped agents */}
          <div
            onDragOver={(e) => { e.preventDefault(); setUngroupedDragOver(true); }}
            onDragLeave={() => setUngroupedDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setUngroupedDragOver(false); handleDrop(null); }}
            className={cn("flex flex-col gap-0.5 rounded transition-colors", ungroupedDragOver && "bg-accent/30")}
          >
            {groupedAgents.ungrouped.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                activeAgentId={activeAgentId}
                activeTab={activeTab}
                runCount={liveCountByAgent.get(agent.id) ?? 0}
                isMobile={isMobile}
                setSidebarOpen={setSidebarOpen}
                onDragStart={setDraggingAgentId}
                dragging={draggingAgentId === agent.id}
              />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
