import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  House,
  CircleCheck,
  SquarePen,
  Users,
  MessageCircle,
  Inbox,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { useCombinedInboxTasksEnabled } from "@/hooks/useCombinedInboxTasksEnabled";
import { Badge } from "@/components/ui/badge";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  type: "link";
  to: string;
  label: string;
  icon: typeof House;
  badge?: number;
}

interface MobileNavActionItem {
  type: "action";
  label: string;
  icon: typeof SquarePen;
  onClick: () => void;
}

type MobileNavItem = MobileNavLinkItem | MobileNavActionItem;

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const location = useLocation();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { enabled: agentChatEnabled } = useAgentChatEnabled();
  const { enabled: combinedInboxTasksEnabled } = useCombinedInboxTasksEnabled();

  // PAP-670: with both flags off the bar is the original Home · Tasks · + ·
  // Agents · Inbox. Agent Chat adds Chat in the second slot (Home · Chat · + ·
  // Tasks · Agents). Combined Inbox + Task List drops Inbox as a destination —
  // it is a view inside Tasks, so its unread badge rides on Tasks. The grid
  // tracks the live count, so the bar stays evenly divided in every mix.
  const items = useMemo<MobileNavItem[]>(
    () => !agentChatEnabled && !combinedInboxTasksEnabled ? [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Tasks", icon: CircleCheck },
      { type: "action", label: "New Task", icon: SquarePen, onClick: () => openNewIssue() },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      {
        type: "link",
        to: "/inbox",
        label: "Inbox",
        icon: Inbox,
        badge: inboxBadge.inbox,
      },
    ] : [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      ...(agentChatEnabled
        ? [{ type: "link", to: "/chats", label: "Chat", icon: MessageCircle } as MobileNavItem]
        : []),
      { type: "action", label: "New Task", icon: SquarePen, onClick: () => openNewIssue() },
      {
        type: "link",
        to: "/issues",
        label: "Tasks",
        icon: CircleCheck,
        badge: combinedInboxTasksEnabled ? inboxBadge.inbox : undefined,
      },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      ...(!combinedInboxTasksEnabled
        ? [{ type: "link", to: "/inbox", label: "Inbox", icon: Inbox, badge: inboxBadge.inbox } as MobileNavItem]
        : []),
    ],
    [openNewIssue, inboxBadge.inbox, agentChatEnabled, combinedInboxTasksEnabled],
  );

  return (
    <nav
      className={cn(
        "mobile-bottom-nav fixed bottom-0 left-0 right-0 z-30 bg-muted md:hidden pb-(--sz-safe-bottom)",
      )}
      data-visible={visible}
      inert={!visible}
      aria-label="Mobile navigation"
    >
      <div
        className="grid h-16 px-1"
        style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      >
        {items.map((item) => {
          if (item.type === "action") {
            const Icon = item.icon;
            const active = /\/issues\/new(?:\/|$)/.test(location.pathname);
            return (
              <button
                key={item.label}
                type="button"
                onClick={item.onClick}
                className={cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-colors",
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-(--sz-18px) w-(--sz-18px)" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          }

          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-(length:--text-nano) font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-(--sz-18px) w-(--sz-18px)", isActive && "stroke-(length:--sw-2_3)")} />
                    {item.badge != null && item.badge > 0 && (
                      <Badge variant="ghost" className="absolute -right-2 -top-2 bg-primary px-1.5 text-(length:--text-nano) leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </Badge>
                    )}
                  </span>
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
