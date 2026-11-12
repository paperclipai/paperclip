import { useMemo } from "react";
import { AgentConversationSidebar } from "./AgentConversationSidebar";
import { queryViewKind } from "./QueryView";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { useLocation, useNavigate } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { agentRouteRef } from "@/lib/utils";
import { useQueries } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { resourceMembershipState, useResourceMemberships } from "@/hooks/useResourceMemberships";
import { useDialogActions } from "@/context/DialogContext";
import { AgentChatPin, agentChatPinKey, useAgentChatPins } from "./AgentChatPin";

/** Account- and company-scoped data for the secondary chat navigation. */
export function AgentConversationsSidebar({ onConversationOpened }: { onConversationOpened?: () => void } = {}) {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const agentChatPins = useAgentChatPins();
  const unreadMessageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const chat of chats.data ?? []) {
      if (chat.conversationAgentId && chat.unreadMessageCount) {
        counts.set(chat.conversationAgentId, (counts.get(chat.conversationAgentId) ?? 0) + chat.unreadMessageCount);
      }
    }
    return counts;
  }, [chats.data]);
  const openChat = useOpenAgentChat(companyId, userId, true);
  const navigate = useNavigate();
  const { openNewAgent } = useDialogActions();
  const memberships = useResourceMemberships(companyId);
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pathname } = useLocation();
  const activeRef = pathname.split("/chats/")[1]?.split("/")[0];
  const roster = agents.data ?? [];
  // The active roster excludes terminated agents, but their history remains readable.
  const rosterIds = new Set(roster.map(agent => agent.id));
  const missingIds = agents.isSuccess ? [...new Set((chats.data ?? [])
    .flatMap(chat => chat.conversationAgentId && !rosterIds.has(chat.conversationAgentId) ? [chat.conversationAgentId] : []))] : [];
  const historyAgents = useQueries({ queries: missingIds.map(id => ({
    queryKey: queryKeys.agents.detail(id), queryFn: () => agentsApi.get(id, companyId!),
  })) });
  const byId = new Map(roster.map(agent => [agent.id, agent]));
  for (const result of historyAgents) if (result.data) byId.set(result.data.id, result.data);
  const active = [...byId.values()].find(agent => agent.id === activeRef || (agent.status !== "terminated" && encodeURIComponent(agentRouteRef(agent)) === activeRef));
  const activeId = active?.id;
  const existingChatAgentIds = useMemo(() => {
    const ids = (chats.data ?? []).flatMap(chat => chat.conversationAgentId ? [chat.conversationAgentId] : []);
    if (activeId && !ids.includes(activeId)) ids.unshift(activeId);
    return ids;
  }, [chats.data, activeId]);
  const unreadAgentIds = useMemo(() => (chats.data ?? [])
    .flatMap(chat => chat.isUnreadForMe && chat.conversationAgentId ? [chat.conversationAgentId] : []), [chats.data]);
  const conversations = (chats.data ?? []).flatMap(chat => {
    const agent = chat.conversationAgentId ? byId.get(chat.conversationAgentId) : undefined;
    return agent ? [agent] : [];
  });
  const uniqueConversations = [...new Map(conversations.map(agent => [agent.id, agent])).values()];
  if (active && !uniqueConversations.some(agent => agent.id === active.id)) uniqueConversations.unshift(active);
  // Everyone you can chat with is listed, not only agents you've already
  // talked to: conversations first by recent activity, then the rest of the
  // roster alphabetically. Same eligibility rule as the Agents nav section —
  // terminated agents and agents you've left are omitted.
  const listedIds = new Set(uniqueConversations.map(agent => agent.id));
  const teammates = roster
    .filter(agent => !listedIds.has(agent.id) && agent.status !== "terminated"
      && (!memberships.isSuccess || resourceMembershipState(memberships.data, "agent", agent.id) !== "left"))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const previews = Object.fromEntries((chats.data ?? []).filter(chat => chat.conversationState === "active")
    .map(chat => [chat.conversationAgentId!, "Working…"]));
  const pinnedAgentIds = useMemo(() => {
    const prefix = `agent-chat:${companyId}:`;
    return agentChatPins.orderedKeys.filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  }, [companyId, agentChatPins.orderedKeys]);
  return <AgentConversationSidebar key={`${companyId}:${userId}`} agents={[...uniqueConversations, ...teammates]} availableAgents={roster}
    chats={(chats.data ?? []).flatMap(chat => { const agent = chat.conversationAgentId ? byId.get(chat.conversationAgentId) : undefined; return agent ? [{ chat, agent }] : []; })}
    onSelectHistory={() => { if (isMobile) setSidebarOpen(false); }}
    existingChatAgentIds={existingChatAgentIds}
    activeId={active?.id} previews={previews}
    unreadAgentIds={unreadAgentIds}
    unreadMessageCounts={unreadMessageCounts}
    pinnedAgentIds={pinnedAgentIds}
    onReorderPins={ids => agentChatPins.reorder(ids.map(id => agentChatPinKey(companyId!, id)))}
    onCreateAgent={openNewAgent} renderAgentAction={agent => <AgentChatPin agent={agent} pins={agentChatPins}
      className={agentChatPins.keys.has(agentChatPinKey(agent.companyId, agent.id)) ? "right-10" : undefined} />}
    // Loaded chats stay listed through an outage (the banner covers it); an
    // outage before the first load is a skeleton, and only a real failure is an error.
    loading={[agents, chats, session].some(query => { const kind = queryViewKind(query); return kind === "loading" || kind === "reconnecting"; })}
    error={[agents, chats, session].find(query => queryViewKind(query) === "error")?.error ?? null}
    onRetry={() => { void agents.refetch(); void chats.refetch(); void session.refetch(); }}
    historyLoading={historyAgents.some(result => result.isPending)}
    historyError={historyAgents.find(result => queryViewKind(result) === "error")?.error}
    onRetryHistory={() => { historyAgents.filter(result => result.isError).forEach(result => { void result.refetch(); }); }}
    onAddChat={async (agent, signal) => { await openChat(agent, signal); if (!signal?.aborted) onConversationOpened?.(); }}
    onSelect={agent => {
      navigate(`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`);
      if (isMobile) setSidebarOpen(false);
    }} />;
}
