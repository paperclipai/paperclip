import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import {
  House,
  CircleDot,
  SquarePen,
  Users,
  Inbox,
} from "lucide-react";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

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
  const { openNewIssue } = useDialog();

  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/issues", label: "Issues", icon: CircleDot },
      { type: "action", label: "Create", icon: SquarePen, onClick: () => openNewIssue() },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      {
        type: "link",
        to: "/inbox",
        label: "Inbox",
        icon: Inbox,
        badge: sidebarBadges?.inbox,
      },
    ],
    [openNewIssue, sidebarBadges?.inbox],
  );

  return (
    <nav
      className={cn(
        "paperclip-panel-strong fixed bottom-3 left-3 right-3 z-30 rounded-[calc(var(--radius)+0.85rem)] transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-[72px] grid-cols-5 gap-1 p-2">
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
                  "relative -mt-5 flex min-w-0 flex-col items-center justify-center gap-1 rounded-[1rem] border px-2 py-3 shadow-[0_16px_30px_color-mix(in_oklab,var(--primary)_16%,transparent)] transition-colors",
                  active
                    ? "border-[color:var(--surface-outline)] bg-primary text-primary-foreground"
                    : "border-[color:var(--surface-outline)] bg-[color:var(--surface-panel-strong)] text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="paperclip-nav-meta truncate text-[0.58rem]">{item.label}</span>
              </button>
            );
          }

          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-[0.95rem] border px-2 py-2 text-[10px] font-medium transition-colors",
                  isActive
                    ? "border-[color:var(--surface-outline)] bg-[color:var(--surface-panel-strong)] text-foreground"
                    : "border-transparent text-muted-foreground hover:border-[color:var(--surface-outline)] hover:bg-[color:var(--surface-panel-muted)] hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
                    {item.badge != null && item.badge > 0 && (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </span>
                  <span className={cn("paperclip-nav-meta truncate text-[0.58rem]", isActive && "text-primary")}>
                    {item.label}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
