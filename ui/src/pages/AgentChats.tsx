import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useAgentChatNavigation, useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
import { useRecentAgentChats } from "@/lib/recent-agent-chats";
import { Link, useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";

export function AgentChats() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyId, userId, enabled, loaded, agents, chats, session } = useAgentChatNavigation();
  useEffect(() => setBreadcrumbs([{ label: "Chat" }]), [setBreadcrumbs]);
  return <AgentChatsContent key={`${companyId}:${userId}`} companyId={companyId} userId={userId}
    enabled={enabled} loaded={loaded} agents={agents} chats={chats} session={session} />;
}

function AgentChatsContent({ companyId, userId, enabled, loaded, agents, chats, session }: Pick<ReturnType<typeof useAgentChatNavigation>, "companyId" | "userId" | "enabled" | "loaded" | "agents" | "chats" | "session">) {
  const openChat = useOpenAgentChat(companyId, userId);
  const navigate = useNavigate();
  const recentIds = useRecentAgentChats(companyId ?? "", userId);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const error = agents.error ?? session.error ?? (recentIds.length > 0 ? chats.error : null);
  // Wait for both lists before skipping a saved ID: terminated agents are absent
  // from the roster but can still have an accessible conversation in chat history.
  const resolvingRecent = recentIds.length > 0 && !error && (!agents.isFetched || !chats.isFetched || !session.isFetched);
  const recentChatPath = loaded && enabled && companyId && !error && !resolvingRecent
    ? recentIds.map(id => {
      const agent = agents.data?.find(item => item.id === id);
      if (agent) return `/chats/${encodeURIComponent(agentRouteRef(agent))}`;
      if (chats.data?.some(chat => chat.conversationAgentId === id)) return `/chats/${encodeURIComponent(id)}`;
      return null;
    }).find((path): path is string => path !== null)
    : undefined;
  useEffect(() => {
    if (recentChatPath) navigate(recentChatPath, { replace: true });
  }, [navigate, recentChatPath]);
  if (!loaded) return <p role="status" className="text-sm text-muted-foreground">Loading chat…</p>;
  if (!enabled) return <p className="text-sm text-muted-foreground">Agent Chat is disabled. Enable it in Experimental settings.</p>;
  if (!companyId) return <p className="text-sm text-muted-foreground">Select a company to start a conversation.</p>;
  if (resolvingRecent || recentChatPath) return <p role="status" className="text-sm text-muted-foreground">Opening chat…</p>;
  return <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-6 px-4 py-12">
    <div className="flex flex-col gap-3">
      <MessageCircle className="size-6 text-muted-foreground" />
      <h1 className="text-xl font-semibold">Who would you like to talk to?</h1>
      <p className="text-sm leading-relaxed text-muted-foreground">Ask a question, think through an idea, or plan the next step with your team.</p>
    </div>
    {error ? <div role="alert" className="flex flex-col items-start gap-3"><p className="text-sm">Couldn’t load your chats.</p><Button variant="outline" onClick={() => { void agents.refetch(); void chats.refetch(); void session.refetch(); }}>Try again</Button></div>
      : agents.isPending || session.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading agents…</p>
      : <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(agents.data ?? []).slice(0, 6).map(agent => <button key={agent.id} type="button" disabled={openingId !== null}
          onClick={async () => {
            setOpeningId(agent.id); setOpenError(null);
            try { await openChat(agent); } catch (error) { setOpenError(error instanceof Error ? error.message : "Couldn’t open chat. Try again."); } finally { setOpeningId(null); }
          }} className="flex items-center gap-3 rounded-lg border border-border p-4 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <AgentAvatar agent={agent} size={32} />
          <span className="flex min-w-0 flex-col gap-1"><span className="truncate text-sm font-medium">{agent.name}</span><span className="text-xs text-muted-foreground">{openingId === agent.id ? "Opening chat…" : agent.title ?? agent.role}</span></span>
        </button>)}
      </div>}
    {openError && <p role="alert" className="text-sm text-destructive">{openError}</p>}
    {agents.data?.length === 0 && <p className="text-sm text-muted-foreground">Add an agent to start a conversation.</p>}
    <Button variant="ghost" className="self-start" asChild><Link to="/agents/all">Browse all agents</Link></Button>
  </div>;
}
