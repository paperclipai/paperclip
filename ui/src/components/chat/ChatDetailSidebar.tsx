import { t, useTranslation } from "@/i18n";
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
import { SidebarNavItem } from "../SidebarNavItem";
import { contextualSidebarStyles } from "../contextual-sidebar-styles";

export function ChatDetailSidebar({
  endpointId,
  NavItem = SidebarNavItem,
}: {
  endpointId: string;
  NavItem?: typeof SidebarNavItem;
}) {
  useTranslation("task-components");
  const endpoint = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId),
  });
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <nav
        aria-label={t("task-components:chatConnection_c3b314ec")}
        data-slot="contextual-sidebar-nav"
        className={contextualSidebarStyles.nav}
      >
        <div
          data-slot="contextual-sidebar-group"
          className={contextualSidebarStyles.group}
        >
          <NavItem
            to={`/apps/chat/${endpointId}/settings`}
            label={t("task-components:settings_74a883a0")}
            icon={Settings}
            end
          />
          <NavItem
            to={`/apps/chat/${endpointId}/access`}
            label={t("task-components:access_ec5ba0ab")}
            icon={Users}
            end
          />
          {endpoint.data?.provider === "github" && (
            <NavItem
              to={`/apps/chat/${endpointId}/reviews`}
              label={t("task-components:reviews_84cb7871")}
              icon={GitPullRequest}
            />
          )}
          <NavItem
            to={`/apps/chat/${endpointId}/conversations`}
            label={t("task-components:conversations_1d432f58")}
            icon={MessageSquare}
            end
          />
          <NavItem
            to={`/apps/chat/${endpointId}/activity`}
            label={t("task-components:activity_38da1505")}
            icon={Activity}
            end
          />
        </div>
      </nav>
    </aside>
  );
}
