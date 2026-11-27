import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import {
  Activity,
  GitPullRequest,
  MessageSquare,
  Settings,
  Users,
} from "lucide-react";
import { MobileContextualNav, type MobileContextualNavItem } from "../MobileContextualNav";
import { SidebarNavItem } from "../SidebarNavItem";
import { contextualSidebarStyles } from "../contextual-sidebar-styles";

function useChatDetailNavItems(endpointId: string): MobileContextualNavItem[] {
  const endpoint = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId),
  });
  const isGitHub = endpoint.data?.provider === "github";

  return useMemo<MobileContextualNavItem[]>(
    () => [
      { key: "settings", to: `/apps/chat/${endpointId}/settings`, label: "Settings", icon: Settings, end: true },
      { key: "access", to: `/apps/chat/${endpointId}/access`, label: "Access", icon: Users, end: true },
      ...(isGitHub
        ? [{ key: "reviews", to: `/apps/chat/${endpointId}/reviews`, label: "Reviews", icon: GitPullRequest }]
        : []),
      { key: "conversations", to: `/apps/chat/${endpointId}/conversations`, label: "Conversations", icon: MessageSquare, end: true },
      { key: "activity", to: `/apps/chat/${endpointId}/activity`, label: "Activity", icon: Activity, end: true },
    ],
    [endpointId, isGitHub],
  );
}

export function ChatDetailSidebar({
  endpointId,
  NavItem = SidebarNavItem,
}: {
  endpointId: string;
  NavItem?: typeof SidebarNavItem;
}) {
  const items = useChatDetailNavItems(endpointId);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <nav
        aria-label="Chat connection"
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        <div
          data-slot="contextual-sidebar-group"
          className={contextualSidebarStyles.group}
        >
          {items.map((item) => (
            <NavItem
              key={item.key}
              to={item.to}
              label={item.label}
              icon={item.icon ?? Settings}
              end={item.end}
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}

export function ChatDetailMobileNav({ endpointId }: { endpointId: string }) {
  const items = useChatDetailNavItems(endpointId);

  return (
    <MobileContextualNav
      surface="chat-detail"
      ariaLabel="Chat connection"
      groups={[{ key: "chat-detail", items }]}
    />
  );
}
