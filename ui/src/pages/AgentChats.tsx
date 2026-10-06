import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { recordedAgentChatIssueId, useRecentAgentChats } from "@/lib/recent-agent-chats";
import { Link, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

export function AgentChats() {
  useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyId, userId, enabled, loaded, agents, chats, session } = useAgentChatNavigation();
  useEffect(() => setBreadcrumbs([{ get label() { return t("oct5Core.chat"); } }]), [setBreadcrumbs]);
  return <AgentChatsContent key={`${companyId}:${userId}`} companyId={companyId} userId={userId}
    enabled={enabled} loaded={loaded} agents={agents} chats={chats} session={session} />;
}

function AgentChatsContent({ companyId, userId, enabled, loaded, agents, chats, session }: Pick<ReturnType<typeof useAgentChatNavigation>, "companyId" | "userId" | "enabled" | "loaded" | "agents" | "chats" | "session">) {
  useTranslation();
  const openChat = useOpenAgentChat(companyId, userId);
  const navigate = useNavigate();
  const recentIds = useRecentAgentChats(companyId ?? "", userId);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<{ message: string } | { key: string } | null>(null);
  const blockingError = agents.error ?? session.error;
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
  useEffect(() => {
    if (recentChatPath) navigate(recentChatPath, { replace: true });
  }, [navigate, recentChatPath]);
  if (!loaded) return <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0202")}</p>;
  if (!enabled) return <p className="text-sm text-muted-foreground">{t("oct5Core.s0203")}</p>;
  if (!companyId) return <p className="text-sm text-muted-foreground">{t("oct5Core.s0204")}</p>;
  if (resolvingRecent || recentChatPath) return <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0205")}</p>;
  const error = blockingError ?? (recentIds.length > 0 ? chats.error : null);
  return <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-6 px-4 py-12">
    <div className="flex flex-col gap-3">
      <MessageCircle className="size-6 text-muted-foreground" />
      <h1 className="text-xl font-semibold">{t("oct5Core.s0206")}</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("oct5Core.s0207")}</p>
    </div>
    {error ? <div role="alert" className="flex flex-col items-start gap-3"><p className="text-sm">{t("oct5Core.s0056")}</p><Button variant="outline" onClick={() => { void agents.refetch(); void chats.refetch(); void session.refetch(); }}>{t("oct5Core.s0057")}</Button></div>
      : agents.isPending || session.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0208")}</p>
      : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(agents.data ?? []).slice(0, 6).map(agent => <button key={agent.id} type="button" disabled={openingId !== null}
          onClick={async () => {
            setOpeningId(agent.id); setOpenError(null);
            try { await openChat(agent); } catch (error) { setOpenError(error instanceof Error ? { message: error.message } : { key: "oct5Core.s0209" }); } finally { setOpeningId(null); }
          }} className="flex items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <AgentAvatar agent={agent} size={32} />
          <span className="flex min-w-0 flex-col gap-1"><span className="truncate text-sm font-medium">{agent.name}</span><span className="text-xs text-muted-foreground">{openingId === agent.id ? t("oct5Core.s0205") : agent.title ?? agent.role}</span></span>
        </button>)}
      </div>}
    {openError && <p role="alert" className="text-sm text-destructive">{"key" in openError ? t(openError.key) : openError.message === "Choose an agent from this company." ? t("oct5Core.chooseCompanyAgent") : openError.message}</p>}
    {agents.data?.length === 0 && <p className="text-sm text-muted-foreground">{t("oct5Core.s0210")}</p>}
    <Button variant="ghost" className="self-start" asChild><Link to="/agents/all">{t("oct5Core.s0067")}</Link></Button>
  </div>;
}
