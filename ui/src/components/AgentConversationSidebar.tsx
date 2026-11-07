import { useTranslation } from "@/i18n";
import { useId, useMemo, useRef, useState } from "react";
import { Plus, Search, Users, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { AgentChatPicker } from "@/components/AgentChatPicker";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, useNavigate } from "@/lib/router";
import { agentRouteRef, cn } from "@/lib/utils";

export interface AgentConversationSidebarProps {
  agents: Agent[];
  /** Agents with a saved conversation; defaults to every listed agent. */
  existingChatAgentIds?: readonly string[];
  availableAgents?: Agent[];
  activeId?: string;
  previews?: Record<string, string>;
  unreadAgentIds?: readonly string[];
  unreadMessageCounts?: ReadonlyMap<string, number>;
  loading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
  initialSearch?: string;
  onSelect?: (agent: Agent, signal?: AbortSignal) => void | Promise<void>;
  onBrowse?: () => void;
  onAddChat?: (agent: Agent, signal?: AbortSignal) => void | Promise<void>;
  historyLoading?: boolean;
  historyError?: Error | null;
  onRetryHistory?: () => void;
}

/** Searchable navigation for one conversation per agent. */
export function AgentConversationSidebar({ agents, existingChatAgentIds, availableAgents = agents, activeId, previews = {}, unreadAgentIds = [], unreadMessageCounts, loading = false, error, onRetry, initialSearch = "", onSelect, onBrowse, onAddChat, historyLoading, historyError, onRetryHistory }: AgentConversationSidebarProps) {
  const { t } = useTranslation("agent-config");
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const unreadIds = useMemo(() => new Set(unreadAgentIds), [unreadAgentIds]);
  const query = search.trim().toLocaleLowerCase();
  const visible = agents.filter(agent => `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLocaleLowerCase().includes(query));
  function focusSearch() {
    setSearch("");
    searchRef.current?.focus();
  }
  return <aside aria-labelledby={headingId} className="flex h-full min-h-0 flex-col border-r border-border bg-background">
    <div className="flex shrink-0 flex-col gap-4 px-3 pb-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">{t("agent-config:chat_2ced57f")}</h2>
        <Button variant="outline" size="icon-sm" aria-label={t("agent-config:addChat_0ee12ab")} title={t("agent-config:addChat_0ee12ab")} onClick={() => setPickerOpen(true)}>
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref={searchRef} aria-label={t("agent-config:searchAgents_f1ff540")} placeholder={t("agent-config:findAnAgent_dfa87ac")} value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setSearch(""); } }}
          className="h-8 pl-8 pr-8 text-xs md:text-xs" />
        {search && <Button variant="ghost" size="icon-xs" aria-label={t("agent-config:clearSearch_67300d0")} className="absolute right-1 top-1/2 -translate-y-1/2" onClick={focusSearch}><X className="size-3" /></Button>}
      </div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 scrollbar-auto-hide">
      <p className="px-2 text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
        {query ? t("agent-config:searchResults_0144dae") : t("agent-config:teammates_ca594ff")}
      </p>
      <span role="status" className="sr-only">{loading ? t("agent-config:loadingAgents_e9d8880") : t("final-configuration:agentCount", { count: visible.length })}</span>
      {historyLoading && <p role="status" className="px-2 text-xs text-muted-foreground">{t("agent-config:loadingChatHistory_6d7762e")}</p>}
      {historyError && <div role="alert" className="flex flex-col items-start gap-2 px-2 py-3">
        <p className="text-xs text-muted-foreground">{t("agent-config:someChatHistoryCouldnTLoad_ec9886d")}</p>
        <Button variant="outline" size="sm" onClick={onRetryHistory}>{t("agent-config:retryChatHistory_a55c5fd")}</Button>
      </div>}
      {error ? <div role="alert" className="flex flex-col items-start gap-2 px-2 py-6"><p className="text-sm">{t("agent-config:couldnTLoadYourChats_6df847d")}</p><Button variant="outline" size="sm" onClick={onRetry}>{t("agent-config:tryAgain_042c862")}</Button></div> : loading ? <div aria-hidden="true" className="flex flex-col gap-1">
        {[0, 1, 2, 3].map(index => <div key={index} className="flex items-center gap-3 rounded-md px-2 py-3 motion-safe:animate-pulse">
          <div className="size-8 shrink-0 rounded-lg bg-muted" />
          <div className="flex flex-1 flex-col gap-2"><div className="h-3 w-2/3 rounded-sm bg-muted" /><div className="h-2 w-full rounded-sm bg-muted" /></div>
        </div>)}
      </div> : visible.length ? <nav aria-label={t("agent-config:agentConversations_4a0447d")} className="flex flex-col gap-1">
        {visible.map(agent => <Link key={agent.id} to={`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`}
          aria-current={activeId === agent.id ? "page" : undefined}
          title={`${agent.name}${agent.title ? ` · ${agent.title}` : ""}`}
          onClick={event => { if (onSelect) { event.preventDefault(); onSelect(agent); } }}
          className={cn("flex min-w-0 items-center gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", activeId === agent.id && "bg-accent text-accent-foreground")}>
          <AgentAvatar agent={agent} size={32} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            <span className="truncate text-xs text-muted-foreground">{agent.status === "terminated" ? t("agent-config:terminated_a1848f4") : agent.status === "paused" ? t("agent-config:paused_c7dfb6f") : previews[agent.id] ?? agent.title ?? t("agent-config:startAConversation_244c20e")}</span>
          </span>
          {unreadIds.has(agent.id) && <span role="img" aria-label={t("agent-config:unreadMessagesFromValue_d329b03", { value1: agent.name })} className="size-2 shrink-0 rounded-full bg-primary" />}
        </Link>)}
      </nav> : !agents.length && (historyLoading || historyError) ? null : <div className="flex flex-col items-start gap-2 px-2 py-6">
        <p className="text-sm font-medium">{agents.length ? t("agent-config:noAgentsFound_b1da2fe") : t("agent-config:noChatsYet_adf8169")}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{agents.length ? t("agent-config:tryAnotherNameOrRole_bb064a7") : t("agent-config:chooseAnAgentToStartAConversation_c86ef1b")}</p>
        {!agents.length && <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>{t("agent-config:chooseAnAgent_faaaf2b")}</Button>}
        {agents.length > 0 && <Button variant="outline" size="sm" onClick={focusSearch}>{t("agent-config:clearSearch_67300d0")}</Button>}
      </div>}
    </div>
    <div className="shrink-0 px-3 py-4">
      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2 text-muted-foreground" asChild={!onBrowse} onClick={onBrowse}>
        {onBrowse ? <><Users className="size-4" />{t("agent-config:browseAllAgents_788dbb9")}</> : <Link to="/agents/all"><Users className="size-4" />{t("agent-config:browseAllAgents_788dbb9")}</Link>}
      </Button>
    </div>
    <AgentChatPicker agents={availableAgents} open={pickerOpen} onOpenChange={setPickerOpen}
      unreadMessageCounts={unreadMessageCounts}
      existingChatAgentIds={existingChatAgentIds ?? agents.map(agent => agent.id)} loading={loading} error={error} onRetry={onRetry}
      renderAgentIcon={agent => <AgentAvatar agent={agent} size={32} />}
      onSelect={async (agent, signal) => {
        if (onAddChat) await onAddChat(agent, signal);
        else if (onSelect) await onSelect(agent, signal);
        else navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}`);
        if (!signal?.aborted) setSearch("");
      }} />
  </aside>;
}
