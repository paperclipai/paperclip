import { Activity, MessageSquare, Settings, Users } from "lucide-react";
import { SidebarNavItem } from "../SidebarNavItem";
import { contextualSidebarStyles } from "../contextual-sidebar-styles";

export function ChatDetailSidebar({ endpointId }: { endpointId: string }) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <nav aria-label="Chat connection" data-slot="contextual-sidebar-nav" className={contextualSidebarStyles.nav}>
        <div data-slot="contextual-sidebar-group" className={contextualSidebarStyles.group}>
          <SidebarNavItem to={`/apps/chat/${endpointId}/settings`} label="Settings" icon={Settings} end />
          <SidebarNavItem to={`/apps/chat/${endpointId}/access`} label="Access" icon={Users} end />
          <SidebarNavItem to={`/apps/chat/${endpointId}/conversations`} label="Conversations" icon={MessageSquare} end />
          <SidebarNavItem to={`/apps/chat/${endpointId}/activity`} label="Activity" icon={Activity} end />
        </div>
      </nav>
    </aside>
  );
}
