import { useState } from "react";
import { Star, Users } from "lucide-react";
import { SidebarSection } from "@/components/SidebarSection";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { useSidebar } from "@/context/SidebarContext";
import type { Agent } from "@paperclipai/shared";
import { agentRouteRef } from "@/lib/utils";
import { orderChatAgents } from "@/lib/recent-agent-chats";
export function AgentChatSidebar({
  activeId,
  starredIds,
  recentIds,
  onToggleStar,
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
}) {
  const [open, setOpen] = useState(true);
  const { collapsed, peeking, isMobile, setSidebarOpen } = useSidebar();
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
            className="absolute right-2 top-(--pct-50) -translate-y-(--pct-50) text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/agent-chat:opacity-100 focus-visible:opacity-100"
          >
            <Star
              aria-hidden="true"
              className={pinned ? "fill-current" : undefined}
            />
          </Button>
        )}
      </div>
    );
  };
  return (
    <>
      <SidebarSection
        label="Agents"
        collapsible={{ open, onOpenChange: setOpen }}
      >
        {ordered.map((agent) => row(agent))}
        <Link
          to="/agents/all"
          className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="See all agents"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
        >
          <Users className="h-4 w-4 shrink-0" />
          {!rail && <span>See all agents</span>}
        </Link>
      </SidebarSection>
    </>
  );
}
