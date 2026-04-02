import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { MessageSquare } from "lucide-react";
import { ChatRoom } from "../components/ChatRoom";
import { AgentIcon } from "../components/AgentIconPicker";
import { chatApi } from "../api/chat";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useParams, useNavigate } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export function Chat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { agentId: selectedAgentId } = useParams<{ agentId?: string }>();
  const navigate = useNavigate();

  // Breadcrumbs
  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  // Fetch all agents
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // Agent map for ChatRoom
  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents) map.set(a.id, a);
    return map;
  }, [agents]);

  // Non-terminated agents for the sidebar list, sorted by name
  const activeAgents = useMemo(
    () =>
      agents
        .filter((a) => a.status !== "terminated")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );

  // Get or create the boardroom room
  const { data: boardroom } = useQuery({
    queryKey: [...queryKeys.chat.rooms(selectedCompanyId!), "boardroom"],
    queryFn: async () => {
      const rooms = await chatApi.listRooms(selectedCompanyId!);
      const existing = rooms.find((r) => r.kind === "boardroom");
      if (existing) return existing;
      return chatApi.getOrCreateRoom(selectedCompanyId!, { kind: "boardroom" });
    },
    enabled: Boolean(selectedCompanyId),
  });

  // Get or create direct room for selected agent
  const { data: directRoom } = useQuery({
    queryKey: [...queryKeys.chat.rooms(selectedCompanyId!), "direct", selectedAgentId],
    queryFn: () =>
      chatApi.getOrCreateRoom(selectedCompanyId!, {
        kind: "direct",
        agentId: selectedAgentId!,
      }),
    enabled: Boolean(selectedCompanyId && selectedAgentId),
  });

  // Determine active room
  const isBoardroom = !selectedAgentId;
  const activeRoomId = isBoardroom ? boardroom?.id : directRoom?.id;
  const selectedAgent = selectedAgentId ? agentMap.get(selectedAgentId) : null;

  return (
    <div className="flex h-full">
      {/* Conversation sidebar */}
      <div className="w-60 shrink-0 border-r border-border flex flex-col overflow-y-auto">
        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Conversations
        </div>

        {/* Boardroom - always first, pinned */}
        <button
          onClick={() => navigate("/chat")}
          className={cn(
            "flex items-center gap-2.5 px-3 py-2 text-sm w-full text-left transition-colors",
            isBoardroom
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50",
          )}
        >
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">Boardroom</span>
        </button>

        <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider border-t border-border mt-1 pt-2">
          Agents
        </div>

        {/* Agent list */}
        {activeAgents.map((agent) => (
          <button
            key={agent.id}
            onClick={() => navigate(`/chat/${agent.id}`)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 text-sm w-full text-left transition-colors",
              selectedAgentId === agent.id
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/50",
            )}
          >
            <AgentIcon icon={agent.icon ?? null} className="h-4 w-4 shrink-0" />
            <span className="truncate">{agent.name}</span>
            {/* Status dot */}
            <span
              className={cn(
                "ml-auto h-2 w-2 rounded-full shrink-0",
                agent.status === "active" || agent.status === "running"
                  ? "bg-green-500"
                  : agent.status === "paused"
                    ? "bg-yellow-500"
                    : agent.status === "error"
                      ? "bg-red-500"
                      : "bg-gray-400",
              )}
            />
          </button>
        ))}
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div className="px-4 py-2.5 border-b border-border flex items-center gap-2.5 shrink-0">
          {isBoardroom ? (
            <>
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-semibold text-sm">Boardroom</div>
                <div className="text-xs text-muted-foreground">
                  Company-wide chat. @mention agents to get their attention.
                </div>
              </div>
            </>
          ) : selectedAgent ? (
            <>
              <AgentIcon
                icon={selectedAgent.icon ?? null}
                className="h-5 w-5"
              />
              <div>
                <div className="font-semibold text-sm">
                  {selectedAgent.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {selectedAgent.title || selectedAgent.role} &middot;{" "}
                  {selectedAgent.status}
                </div>
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              Select a conversation
            </div>
          )}
        </div>

        {/* Chat content */}
        <div className="flex-1 min-h-0">
          {activeRoomId ? (
            <ChatRoom
              roomId={activeRoomId}
              roomAgentId={selectedAgentId ?? null}
              agentMap={agentMap}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {isBoardroom
                ? "Loading boardroom..."
                : selectedAgentId
                  ? "Loading conversation..."
                  : "Select a conversation to start chatting"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
