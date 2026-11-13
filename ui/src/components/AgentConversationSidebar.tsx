import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Plus, Search, Users, X } from "lucide-react";
import { SortablePinnedList, SortablePinnedRow } from "./PinnedNavigationList";
import { Badge } from "./ui/badge";
import type { Agent } from "@paperclipai/shared";
import { AgentChatPicker } from "@/components/AgentChatPicker";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTx } from "@/i18n/tx";
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
  onCreateAgent?: () => void;
  renderAgentAction?: (agent: Agent) => ReactNode;
  pinnedAgentIds?: readonly string[];
  onReorderPins?: (ids: string[]) => void;
  /** When the company has at least one department, the list can switch to collapsible stacks. */
  departments?: readonly { id: string; name: string; agentIds: readonly string[] }[];
  departmentError?: unknown;
  onRetryDepartments?: () => void;
}

const NO_PINNED_AGENTS: readonly string[] = [];
const UNASSIGNED_DEPARTMENT_STACK = "__unassigned__";
const contactRowClassName = "agent-pin-row agent-contact-pin-row group/agent-pin relative rounded-md";

type ChatDepartment = { id: string; name: string; agentIds: readonly string[] };

/** Agents keep the incoming order. A person in two departments is in both stacks. */
function chatDepartmentStacks(agents: readonly Agent[], departments: readonly ChatDepartment[]) {
  const stacks = departments
    .map((department) => ({
      id: department.id,
      name: department.name,
      agents: agents.filter((agent) => department.agentIds.includes(agent.id)),
    }))
    .filter((stack) => stack.agents.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const assigned = new Set(departments.flatMap((department) => department.agentIds));
  const unassigned = agents.filter((agent) => !assigned.has(agent.id));
  if (unassigned.length > 0) stacks.push({ id: UNASSIGNED_DEPARTMENT_STACK, name: "No department", agents: unassigned });
  return stacks;
}

/** Searchable navigation for one conversation per agent. */
export function AgentConversationSidebar({ agents, existingChatAgentIds, availableAgents = agents, activeId, previews = {}, unreadAgentIds = [], unreadMessageCounts, loading = false, error, onRetry, initialSearch = "", onSelect, onBrowse, onAddChat, historyLoading, historyError, onRetryHistory, onCreateAgent, renderAgentAction, pinnedAgentIds = NO_PINNED_AGENTS, onReorderPins, departments, departmentError, onRetryDepartments }: AgentConversationSidebarProps) {
  const navigate = useNavigate();
  const tx = useTx();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const [view, setView] = useState<"list" | "departments">("list");
  const [collapsedStacks, setCollapsedStacks] = useState<ReadonlySet<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const unreadIds = useMemo(() => new Set(unreadAgentIds), [unreadAgentIds]);
  const pinnedIds = useMemo(() => new Set(pinnedAgentIds), [pinnedAgentIds]);
  const canGroup = (departments?.length ?? 0) > 0;
  const grouped = canGroup && view === "departments";
  const query = search.trim().toLocaleLowerCase();
  const matching = agents.filter(agent => `${agent.name} ${agent.title ?? ""} ${agent.role}`.toLocaleLowerCase().includes(query));
  const byId = new Map(matching.map(agent => [agent.id, agent]));
  const pins = pinnedAgentIds.flatMap(id => {
    const agent = byId.get(id);
    return agent ? [agent] : [];
  });
  const visible = [...pins, ...matching.filter(agent => !pinnedIds.has(agent.id))];
  const visiblePinnedIds = pins.map(agent => agent.id);
  const stacks = grouped && departments ? chatDepartmentStacks(visible, departments) : [];
  function toggleStack(id: string) {
    setCollapsedStacks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function focusSearch() {
    setSearch("");
    searchRef.current?.focus();
  }
  function contactContent(agent: Agent, canReorder: boolean) {
    const unreadCount = unreadMessageCounts?.get(agent.id) ?? 0;
    const hasUnread = unreadCount > 0 || unreadIds.has(agent.id);
    const node = <><Link to={`/chats/${encodeURIComponent(agent.status === "terminated" ? agent.id : agentRouteRef(agent))}`}
      aria-current={activeId === agent.id ? "page" : undefined}
      title={`${agent.name}${agent.title ? ` · ${agent.title}` : ""}`}
      onClick={event => { if (onSelect) { event.preventDefault(); onSelect(agent); } }}
      className={cn("agent-contact-row flex min-w-0 items-center gap-3 rounded-md px-2.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", renderAgentAction && hasUnread && "pr-12", canReorder && "pr-20", activeId === agent.id ? "bg-accent text-accent-foreground" : "group-hover/agent-pin:bg-accent/60 group-focus-within/agent-pin:bg-accent/60")}>
      <AgentAvatar agent={agent} size={40} />
      <span className="agent-pin-text flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{agent.name}</span>
        <span className="truncate text-xs text-muted-foreground">{agent.status === "terminated" ? "Terminated" : agent.title ?? agent.role}</span>
      </span>
      {unreadCount > 0 ? <Badge variant="ghost" aria-label={`${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"} from ${agent.name}`} className="shrink-0 bg-primary font-mono tabular-nums text-primary-foreground">{unreadCount}</Badge>
        : unreadIds.has(agent.id) && <span role="img" aria-label={`Unread messages from ${agent.name}`} className="size-2 shrink-0 rounded-full bg-primary" />}
    </Link>{renderAgentAction?.(agent)}</>;
    return { hasUnread, node };
  }
  return <aside aria-labelledby={headingId} className="flex h-full min-h-0 flex-col border-r border-border bg-background">
    <h2 id={headingId} className="sr-only">Chat contacts</h2>
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-5">
      <div className="relative min-w-0">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref={searchRef} aria-label="Search chats" placeholder="Search chats" value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setSearch(""); } }}
          className="h-9 pl-8 pr-8 text-xs md:text-xs" />
        {search && <Button variant="ghost" size="icon-xs" aria-label="Clear search" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={focusSearch}><X className="size-3" /></Button>}
      </div>
      {canGroup && <div role="group" aria-label={tx("Chat list layout")} className="grid grid-cols-2 rounded-md bg-muted p-0.5">
        <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}
          className={cn("h-7 rounded-[5px] px-2 text-xs font-medium", view === "list" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{tx("List")}</button>
        <button type="button" aria-pressed={view === "departments"} onClick={() => setView("departments")}
          className={cn("h-7 rounded-[5px] px-2 text-xs font-medium", view === "departments" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{tx("By department")}</button>
      </div>}
      {!!departmentError && <p role="alert" className="text-xs text-destructive">{tx("Departments couldn’t be loaded.")} {onRetryDepartments && <Button variant="link" size="sm" onClick={onRetryDepartments}>Retry</Button>}</p>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 scrollbar-auto-hide">
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
        {grouped ? stacks.map(stack => {
          const open = !collapsedStacks.has(stack.id);
          const unread = stack.agents.reduce((sum, agent) => sum + Math.max(unreadMessageCounts?.get(agent.id) ?? 0, unreadIds.has(agent.id) ? 1 : 0), 0);
          const label = stack.id === UNASSIGNED_DEPARTMENT_STACK ? tx(stack.name) : stack.name;
          return <div key={stack.id} className="flex flex-col not-first:mt-1">
            <button type="button" aria-expanded={open} onClick={() => toggleStack(stack.id)}
              className="group/stack flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40 focus-visible:text-foreground focus-visible:outline-none">
              <ChevronRight aria-hidden="true" className={cn("size-3 shrink-0 opacity-60 transition-transform duration-150 group-hover/stack:opacity-100", open && "rotate-90")} />
              <span className="min-w-0 truncate text-xs font-medium">{label}</span>
              <span className="shrink-0 text-[11px] tabular-nums opacity-60">{stack.agents.length}</span>
              {unread > 0 && <span role="img" aria-label={`${unread} unread`} className="size-1.5 shrink-0 rounded-full bg-primary" />}
            </button>
            {open && <div className="flex flex-col gap-0.5">
              {stack.agents.map(agent => {
                const { hasUnread, node } = contactContent(agent, false);
                return <div key={`${stack.id}:${agent.id}`} className={contactRowClassName}
                  data-selected={activeId === agent.id || undefined} data-has-unread={hasUnread || undefined}>{node}</div>;
              })}
            </div>}
          </div>;
        }) : <SortablePinnedList keys={visiblePinnedIds} onReorder={onReorderPins}>
          {visible.map(agent => {
            const canReorder = pinnedIds.has(agent.id) && !!onReorderPins;
            const { hasUnread, node } = contactContent(agent, canReorder);
            return <SortablePinnedRow key={agent.id} id={agent.id} label={agent.name} disabled={!canReorder} className={contactRowClassName}
              data-selected={activeId === agent.id || undefined} data-has-unread={hasUnread || undefined}
              handleClassName="agent-chat-pin right-2 size-8 focus-visible:outline-none group-hover/agent-pin:opacity-100 group-focus-within/agent-pin:opacity-100" handleIconClassName="size-4">{node}</SortablePinnedRow>;
          })}
        </SortablePinnedList>}
      </nav> : !agents.length && (historyLoading || historyError) ? null : <div className="flex flex-col items-start gap-2 px-2 py-6">
        <p className="text-sm font-medium">{agents.length ? "No agents found" : "No chats yet"}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{agents.length ? "Try another name or role." : "Choose an agent to start a conversation."}</p>
        {!agents.length && <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>Choose an agent</Button>}
        {agents.length > 0 && !!query && <Button variant="outline" size="sm" onClick={focusSearch}>Clear search</Button>}
      </div>}
      {onCreateAgent && !loading && !error && <button type="button" onClick={onCreateAgent}
        className="flex min-w-0 items-center gap-3 rounded-md px-2.5 py-3 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center"><span className="agent-contact-create flex size-8 items-center justify-center bg-muted"><Plus className="size-5 text-foreground" /></span></span>
        <span className="text-sm font-medium">{tx("Create a new agent")}</span>
      </button>}
    </div>
    {onBrowse && <div className="shrink-0 px-3 py-4">
      <Button variant="ghost" size="sm" className="w-full justify-start gap-2 px-2 text-muted-foreground" onClick={onBrowse}>
        <Users className="size-4" />Browse all agents
      </Button>
    </div>}
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
