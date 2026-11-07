import { useMemo } from "react";
import { AgentConversationSidebar } from "./AgentConversationSidebar";
import { queryViewKind } from "./QueryView";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { useLocation, useNavigate } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import { agentRouteRef } from "@/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { builtInAgentsApi } from "@/api/builtInAgents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { resourceMembershipState, useResourceMemberships } from "@/hooks/useResourceMemberships";
import { useDialogActions } from "@/context/DialogContext";
import { AgentChatPin, useAgentChatPins } from "./AgentChatPin";
import { AgentChatMenu, canArchiveAgentFromChat } from "./AgentChatMenu";
import { useCanManageCompanyAgents } from "@/hooks/useCanManageCompanyAgents";

/** Account- and company-scoped data for the secondary chat navigation. */
export function AgentConversationsSidebar() {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const agentChatPins = useAgentChatPins();
  const unreadMessageCounts = useMemo(() => new Map((chats.data ?? [])
    .flatMap(chat => chat.conversationAgentId && chat.unreadMessageCount
      ? [[chat.conversationAgentId, chat.unreadMessageCount] as const] : [])), [chats.data]);
  const openChat = useOpenAgentChat(companyId, userId);
  const navigate = useNavigate();
  const { openNewAgent } = useDialogActions();
  const memberships = useResourceMemberships(companyId);
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pathname } = useLocation();
  const activeRef = pathname.split("/chats/")[1]?.split("/")[0];
  const roster = agents.data ?? [];
  const canManageAgents = useCanManageCompanyAgents(companyId);
  const experimentalSettings = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: canManageAgents,
  });
  const builtInAgentsEnabled = experimentalSettings.data?.enableBuiltInAgents === true;
  const builtInAgents = useQuery({
    queryKey: queryKeys.builtInAgents.list(companyId!),
    queryFn: () => builtInAgentsApi.list(companyId!),
    enabled: canManageAgents && !!companyId && builtInAgentsEnabled,
  });
  // Built-in agents can't be terminated (the agent page hides Terminate), so
  // offer Archive only once their list has loaded.
  const archivableBuiltInsKnown = experimentalSettings.isSuccess && (!builtInAgentsEnabled || builtInAgents.isSuccess);
  const builtInAgentIds = useMemo(() => new Set((builtInAgents.data ?? []).flatMap(entry => entry.agentId ? [entry.agentId] : [])), [builtInAgents.data]);
  // Archived (terminated) agents leave the chat list; the open chat stays
  // listed and its history stays readable by id.
  const missingIds = agents.isSuccess ? [...new Set((chats.data ?? [])
    .flatMap(chat => chat.conversationAgentId === activeRef && !roster.some(agent => agent.id === chat.conversationAgentId) ? [chat.conversationAgentId] : []))] : [];
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
    return agent && (agent.status !== "terminated" || agent.id === activeId) ? [agent] : [];
  });
  if (active && !conversations.some(agent => agent.id === active.id)) conversations.unshift(active);
  // Everyone you can chat with is listed, not only agents you've already
  // talked to: conversations first by recent activity, then the rest of the
  // roster alphabetically. Same eligibility rule as the Agents nav section —
  // terminated agents and agents you've left are omitted.
  const listedIds = new Set(conversations.map(agent => agent.id));
  const teammates = roster
    .filter(agent => !listedIds.has(agent.id) && agent.status !== "terminated"
      && (!memberships.isSuccess || resourceMembershipState(memberships.data, "agent", agent.id) !== "left"))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const previews = Object.fromEntries((chats.data ?? []).filter(chat => chat.conversationState === "active")
    .map(chat => [chat.conversationAgentId!, "Working…"]));
  return <AgentConversationSidebar key={`${companyId}:${userId}`} agents={[...conversations, ...teammates]} availableAgents={roster}
    existingChatAgentIds={existingChatAgentIds}
    activeId={active?.id} previews={previews}
    unreadAgentIds={unreadAgentIds}
    unreadMessageCounts={unreadMessageCounts}
    onCreateAgent={openNewAgent} renderAgentAction={agent => canManageAgents && archivableBuiltInsKnown && !builtInAgentIds.has(agent.id) && canArchiveAgentFromChat(agent)
      // One surface behind both row actions hides the name under them on hover.
      ? <span className="agent-chat-pin absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md opacity-0 transition-opacity group-hover/agent-pin:opacity-100 group-focus-within/agent-pin:opacity-100 pointer-coarse:opacity-100 has-[[data-state=open]]:opacity-100">
        <AgentChatMenu agent={agent} userId={userId} onArchived={archived => {
          // Keep an open chat readable: terminated chats open by id.
          if (archived.id === activeId) navigate(`/chats/${encodeURIComponent(archived.id)}`, { replace: true });
        }} />
        <AgentChatPin agent={agent} pins={agentChatPins} className="static translate-y-0" />
      </span>
      : <AgentChatPin agent={agent} pins={agentChatPins} />}
    // Loaded chats stay listed through an outage (the banner covers it); an
    // outage before the first load is a skeleton, and only a real failure is an error.
    loading={[agents, chats, session].some(query => { const kind = queryViewKind(query); return kind === "loading" || kind === "reconnecting"; })}
    error={[agents, chats, session].find(query => queryViewKind(query) === "error")?.error ?? null}
    onRetry={() => { void agents.refetch(); void chats.refetch(); void session.refetch(); }}
    historyLoading={historyAgents.some(result => result.isPending)}
    historyError={historyAgents.find(result => queryViewKind(result) === "error")?.error}
    onRetryHistory={() => { historyAgents.filter(result => result.isError).forEach(result => { void result.refetch(); }); }}
    onAddChat={openChat}
    onSelect={agent => {
      navigate(`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`);
      if (isMobile) setSidebarOpen(false);
    }} />;
}
