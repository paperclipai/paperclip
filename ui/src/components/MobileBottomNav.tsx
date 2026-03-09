import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  House,
  LayoutGrid,
  SquarePen,
  Users,
  FolderOpen,
} from "lucide-react";
import { useDialog } from "../context/DialogContext";
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
  const { openNewIssue } = useDialog();

  const items = useMemo<MobileNavItem[]>(
    () => [
      { type: "link", to: "/dashboard", label: "Home", icon: House },
      { type: "link", to: "/projects", label: "Projects", icon: LayoutGrid },
      { type: "action", label: "Create", icon: SquarePen, onClick: () => openNewIssue() },
      { type: "link", to: "/agents/all", label: "Agents", icon: Users },
      { type: "link", to: "/folders", label: "Folders", icon: FolderOpen },
    ],
    [openNewIssue],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)] shadow-[0_-20px_50px_-32px_rgba(0,0,0,0.65)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="Mobile navigation"
    >
      <div className="grid h-16 grid-cols-5 gap-1 px-2">
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
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
                  active
                    ? "bg-[var(--surface-highlight)]/12 text-foreground"
                    : "text-muted-foreground hover:bg-accent/45 hover:text-foreground",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
                <span className="truncate">{item.label}</span>
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
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium transition-colors",
                  isActive
                    ? "bg-[var(--surface-highlight)]/12 text-foreground"
                    : "text-muted-foreground hover:bg-accent/45 hover:text-foreground",
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
