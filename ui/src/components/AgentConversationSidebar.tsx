import { useId, useRef, useState } from "react";
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
export function AgentConversationSidebar({ agents, existingChatAgentIds, availableAgents = agents, activeId, previews = {}, loading = false, error, onRetry, initialSearch = "", onSelect, onBrowse, onAddChat, historyLoading, historyError, onRetryHistory }: AgentConversationSidebarProps) {
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const query = search.trim().toLocaleLowerCase();
  const visible = agents.filter(agent => `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLocaleLowerCase().includes(query));
  function focusSearch() {
    setSearch("");
    searchRef.current?.focus();
  }
  return <aside aria-labelledby={headingId} className="flex h-full min-h-0 flex-col border-r border-border bg-background">
    <div className="flex shrink-0 flex-col gap-4 px-3 pb-4 pt-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id={headingId} className="text-sm font-semibold">Chat</h2>
        <Button variant="outline" size="icon-sm" aria-label="Add chat" title="Add chat" onClick={() => setPickerOpen(true)}>
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref={searchRef} aria-label="Search agents" placeholder="Find an agent" value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setSearch(""); } }}
          className="h-8 pl-8 pr-8 text-xs md:text-xs" />
        {search && <Button variant="ghost" size="icon-xs" aria-label="Clear search" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={focusSearch}><X className="size-3" /></Button>}
      </div>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 scrollbar-auto-hide">
      <p className="px-2 text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
        {query ? "Search results" : "Teammates"}
      </p>
      <span role="status" className="sr-only">{loading ? "Loading agents" : `${visible.length} ${visible.length === 1 ? "agent" : "agents"}`}</span>
      {historyLoading && <p role="status" className="px-2 text-xs text-muted-foreground">Loading chat history…</p>}
      {historyError && <div role="alert" className="flex flex-col items-start gap-2 px-2 py-3">
        <p className="text-xs text-muted-foreground">Some chat history couldn’t load.</p>
        <Button variant="outline" size="sm" onClick={onRetryHistory}>Retry chat history</Button>
      </div>}
      {error ? <div role="alert" className="flex flex-col items-start gap-2 px-2 py-6"><p className="text-sm">Couldn’t load your chats.</p><Button variant="outline" size="sm" onClick={onRetry}>Try again</Button></div> : loading ? <div aria-hidden="true" className="flex flex-col gap-1">
        {[0, 1, 2, 3].map(index => <div key={index} className="flex items-center gap-3 rounded-md px-2 py-3 motion-safe:animate-pulse">
          <div className="size-8 shrink-0 rounded-lg bg-muted" />
          <div className="flex flex-1 flex-col gap-2"><div className="h-3 w-2/3 rounded-sm bg-muted" /><div className="h-2 w-full rounded-sm bg-muted" /></div>
        </div>)}
      </div> : visible.length ? <nav aria-label="Agent conversations" className="flex flex-col gap-1">
        {visible.map(agent => <Link key={agent.id} to={`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`}
          aria-current={activeId === agent.id ? "page" : undefined}
          title={`${agent.name}${agent.title ? ` · ${agent.title}` : ""}`}
          onClick={event => { if (onSelect) { event.preventDefault(); onSelect(agent); } }}
          className={cn("flex min-w-0 items-center gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", activeId === agent.id && "bg-accent text-accent-foreground")}>
          <AgentAvatar agent={agent} size={32} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{agent.name}</span>
            <span className="truncate text-xs text-muted-foreground">{agent.status === "terminated" ? "Terminated" : agent.status === "paused" ? "Paused" : previews[agent.id] ?? agent.title ?? "Start a conversation"}</span>
          </span>
        </Link>)}
      </nav> : !agents.length && (historyLoading || historyError) ? null : <div className="flex flex-col items-start gap-2 px-2 py-6">
        <p className="text-sm font-medium">{agents.length ? "No agents found" : "No chats yet"}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{agents.length ? "Try another name or role." : "Choose an agent to start a conversation."}</p>
        {!agents.length && <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>Choose an agent</Button>}
        {agents.length > 0 && <Button variant="outline" size="sm" onClick={focusSearch}>Clear search</Button>}
      </div>}
    </div>
    <div className="shrink-0 px-3 py-4">
      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2 text-muted-foreground" asChild={!onBrowse} onClick={onBrowse}>
        {onBrowse ? <><Users className="size-4" />Browse all agents</> : <Link to="/agents/all"><Users className="size-4" />Browse all agents</Link>}
      </Button>
    </div>
    <AgentChatPicker agents={availableAgents} open={pickerOpen} onOpenChange={setPickerOpen}
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
