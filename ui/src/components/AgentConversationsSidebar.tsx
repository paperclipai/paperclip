import { AgentConversationSidebar } from "./AgentConversationSidebar";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { useLocation, useNavigate } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { agentRouteRef } from "@/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

/** Account- and company-scoped data for the secondary chat navigation. */
export function AgentConversationsSidebar() {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const openChat = useOpenAgentChat(companyId, userId);
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pathname } = useLocation();
  const activeRef = pathname.split("/chats/")[1]?.split("/")[0];
  const roster = agents.data ?? [];
  // The active roster excludes terminated agents, but their history remains readable.
  const missingIds = agents.isSuccess ? [...new Set((chats.data ?? [])
    .flatMap(chat => chat.conversationAgentId && !roster.some(agent => agent.id === chat.conversationAgentId) ? [chat.conversationAgentId] : []))] : [];
  const historyAgents = useQueries({ queries: missingIds.map(id => ({
    queryKey: queryKeys.agents.detail(id), queryFn: () => agentsApi.get(id, companyId!),
  })) });
  const byId = new Map(roster.map(agent => [agent.id, agent]));
  for (const result of historyAgents) if (result.data) byId.set(result.data.id, result.data);
  const active = [...byId.values()].find(agent => agent.id === activeRef || (agent.status !== "terminated" && encodeURIComponent(agentRouteRef(agent)) === activeRef));
  const conversations = (chats.data ?? []).flatMap(chat => {
    const agent = chat.conversationAgentId ? byId.get(chat.conversationAgentId) : undefined;
    return agent ? [agent] : [];
  });
  if (active && !conversations.some(agent => agent.id === active.id)) conversations.unshift(active);
  const previews = Object.fromEntries((chats.data ?? []).filter(chat => chat.conversationState === "active")
    .map(chat => [chat.conversationAgentId!, "Working…"]));
  return <AgentConversationSidebar key={`${companyId}:${userId}`} agents={conversations} availableAgents={roster}
    activeId={active?.id} previews={previews}
    loading={agents.isPending || chats.isPending || session.isPending}
    error={agents.error ?? chats.error ?? session.error}
    onRetry={() => { void agents.refetch(); void chats.refetch(); void session.refetch(); }}
    historyLoading={historyAgents.some(result => result.isPending)}
    historyError={historyAgents.find(result => result.error)?.error}
    onRetryHistory={() => { historyAgents.filter(result => result.isError).forEach(result => { void result.refetch(); }); }}
    onAddChat={openChat}
    onSelect={agent => {
      navigate(`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`);
      if (isMobile) setSidebarOpen(false);
    }} />;
}
