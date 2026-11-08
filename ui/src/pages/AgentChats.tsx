import { useTranslation } from "@/i18n";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { recordedAgentChatIssueId, useRecentAgentChats } from "@/lib/recent-agent-chats";
import { Link, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

export function AgentChats() {
  const { t: translateAgentPage } = useTranslation("agents");
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyId, userId, enabled, loaded, agents, chats, session } = useAgentChatNavigation();
  useEffect(() => setBreadcrumbs([{ label: translateAgentPage("agents:chat") }]), [setBreadcrumbs, translateAgentPage]);
  return <AgentChatsContent key={`${companyId}:${userId}`} companyId={companyId} userId={userId}
    enabled={enabled} loaded={loaded} agents={agents} chats={chats} session={session} />;
}

function AgentChatsContent({ companyId, userId, enabled, loaded, agents, chats, session }: Pick<ReturnType<typeof useAgentChatNavigation>, "companyId" | "userId" | "enabled" | "loaded" | "agents" | "chats" | "session">) {
  const { t: translateAgentPage } = useTranslation("agents");
  const primary = usePrimaryAgentPresentation(companyId);
  const openChat = useOpenAgentChat(companyId, userId);
  const navigate = useNavigate();
  const recentIds = useRecentAgentChats(companyId ?? "", userId);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const agentsView = useQueryView(agents);
  const sessionView = useQueryView(session);
  const chatsView = useQueryView(chats);
  // Only a real failure blocks the entry redirect; an outage waits it out below.
  const blockingError = agentsView.kind === "error" ? agents.error : sessionView.kind === "error" ? session.error : null;
  const reconnecting = agentsView.kind === "reconnecting" || sessionView.kind === "reconnecting" || chatsView.kind === "reconnecting";
  const firstId = recentIds[0];
  const firstAgent = agents.data?.find(agent => agent.id === firstId);
  // An empty chat with an active agent can reopen from the roster alone. A
  // missing agent or a saved issue needs history to validate that visit.
  const needsHistory = !!firstId && (!firstAgent || !!recordedAgentChatIssueId(companyId ?? "", userId, firstId));
  const resolvingRecent = recentIds.length > 0 && !blockingError && (!agents.isFetched || !session.isFetched || (needsHistory && !chats.isFetched && !chats.error));
  const recentChatPath = loaded && enabled && companyId && !blockingError && !resolvingRecent
    ? recentIds.map(id => {
      const agent = agents.data?.find(item => item.id === id);
      const historyIssue = chats.data?.find(chat => chat.conversationAgentId === id);
      const savedIssueId = recordedAgentChatIssueId(companyId, userId, id);
      // A deleted or inaccessible issue must not silently reopen as a new chat.
      if (savedIssueId && chats.isSuccess && historyIssue?.id !== savedIssueId) return null;
      if (agent) return `/chats/${encodeURIComponent(agentRouteRef(agent))}`;
      if (historyIssue) return `/chats/${encodeURIComponent(id)}`;
      return null;
    }).find((path): path is string => path !== null)
    : undefined;
  const primaryAgent = agents.data?.find(agent => agent.id === primary?.primaryAgentId
    && agent.status !== "terminated" && agent.status !== "pending_approval");
  const entryPath = recentChatPath ?? (loaded && enabled && !blockingError && !resolvingRecent
    && agents.isFetched && session.isFetched && !primary?.loading && primaryAgent
    ? `/chats/${encodeURIComponent(agentRouteRef(primaryAgent))}` : undefined);
  useEffect(() => {
    if (entryPath) navigate(entryPath, { replace: true });
  }, [navigate, entryPath]);
  if (!loaded) return <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_chat")}</p>;
  if (!enabled) return <p className="text-sm text-muted-foreground">{translateAgentPage("agents:agent_chat_is_off_for_this_instance_an")}{" "}<Link className="underline underline-offset-4" to="/company/settings/instance/experimental#experimental-enableAgentChat">{translateAgentPage("agents:experimental_settings")}</Link>{translateAgentPage("agents:your_workspace_preference_does_not_change_chat_availability_c0f8de")}</p>;
  if (!companyId) return <p className="text-sm text-muted-foreground">{translateAgentPage("agents:select_a_company_to_start_a_conversation")}</p>;
  if (reconnecting) return <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_chat")}</p>;
  if (resolvingRecent || entryPath || primary?.loading) return <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:opening_chat")}</p>;
  const error = blockingError ?? (recentIds.length > 0 && chatsView.kind === "error" ? chats.error : null);
  return <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-6 px-4 py-12">
    <div className="flex flex-col gap-3">
      <MessageCircle className="size-6 text-muted-foreground" />
      <h1 className="text-xl font-semibold">{translateAgentPage("agents:who_would_you_like_to_talk_to")}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{translateAgentPage("agents:ask_a_question_think_through_an_idea_or")}</p>
    </div>
    {error ? <QueryErrorState error={error} action={translateAgentPage("agents:load_your_chats")} onRetry={() => { agentsView.retry(); chatsView.retry(); sessionView.retry(); }} />
      : agents.isPending || session.isPending ? <p role="status" className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_agents")}</p>
      : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(agents.data ?? []).slice(0, 6).map(agent => <button key={agent.id} type="button" disabled={openingId !== null}
          onClick={async () => {
            setOpeningId(agent.id); setOpenError(null);
            try { await openChat(agent); } catch (error) { setOpenError(error instanceof Error ? error.message : translateAgentPage("agents:couldn_t_open_chat_try_again")); } finally { setOpeningId(null); }
          }} className="flex items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <AgentAvatar agent={agent} size={32} />
          <span className="flex min-w-0 flex-col gap-1"><span className="truncate text-sm font-medium">{agent.name}</span><span className="text-xs text-muted-foreground">{openingId === agent.id ? translateAgentPage("agents:opening_chat") : agent.title ?? agent.role}</span></span>
        </button>)}
      </div>}
    {openError && <p role="alert" className="text-sm text-destructive">{openError}</p>}
    {agents.data?.length === 0 && <p className="text-sm text-muted-foreground">{translateAgentPage("agents:add_an_agent_to_start_a_conversation")}</p>}
    <Button variant="ghost" className="self-start" asChild><Link to="/agents/all">{translateAgentPage("agents:browse_all_agents")}</Link></Button>
  </div>;
}
