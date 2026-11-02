import { Star, SquarePen } from "lucide-react";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/context/SidebarContext";
import type { Agent } from "@paperclipai/shared";
import { agentRouteRef, cn } from "@/lib/utils";
import { orderChatAgents } from "@/lib/recent-agent-chats";
export function AgentChatSidebar({
  activeId,
  starredIds,
  recentIds,
  onToggleStar,
  onOpenChat,
  agents,
  href = (id: string) =>
    `/chats/${encodeURIComponent(agentRouteRef(agents.find((agent) => agent.id === id)!))}`,
}: {
  agents: Agent[];
  href?: (id: string) => string;
  activeId: string;
  starredIds: string[];
  recentIds: string[];
  onToggleStar: (id: string) => void;
  onOpenChat: () => void;
}) {
  const { collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const ordered = orderChatAgents(agents, starredIds, recentIds);
  const row = (agent: Agent) => {
    const pinned = starredIds.includes(agent.id);
    return (
      <div key={agent.id} className="group/agent-chat relative">
        <SidebarNavItem
          to={href(agent.id)}
          label={agent.name}
          active={activeId === agent.id}
          iconNode={
            <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0" />
          }
          className={rail ? undefined : "pr-9"}
        />
        {!rail && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${pinned ? "Unstar" : "Star"} ${agent.name}`}
            aria-pressed={pinned}
            title={pinned ? "Unstar agent" : "Star agent to pin"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleStar(agent.id);
            }}
            className={cn("absolute right-2 top-(--pct-50) -translate-y-(--pct-50) text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/agent-chat:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100", pinned && "opacity-100")}
          >
            <Star
              aria-hidden="true"
              className={cn("size-3.5", pinned && "fill-current")}
            />
          </Button>
        )}
      </div>
    );
  };
  return (
    <section aria-label="Chats" className="group/chats flex flex-col gap-0.5">
      <div className="relative flex min-h-9 items-center px-4 py-1.5">
        <span className={cn("font-mono text-(length:--text-nano) font-medium uppercase tracking-widest text-muted-foreground/60", rail && "sr-only")}>Chats</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Chat with an agent"
          title="Chat with an agent"
          onClick={onOpenChat}
          className="absolute right-2 top-(--pct-50) -translate-y-(--pct-50) text-muted-foreground opacity-0 group-hover/chats:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <SquarePen aria-hidden="true" className="size-3.5" />
        </Button>
      </div>
      {ordered.map(row)}
    </section>
  );
}
