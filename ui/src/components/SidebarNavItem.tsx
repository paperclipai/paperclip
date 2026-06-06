import { NavLink } from "@/lib/router";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import type { LucideIcon } from "lucide-react";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  end,
  className,
  badge,
  badgeTone = "default",
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "relative flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-full before:bg-primary"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          className,
        )
      }
    >
      {({ isActive }) => (
        <>
          <span className="relative shrink-0">
            <Icon className={cn("h-4 w-4", isActive && "text-primary")} />
            {alert && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-status-error shadow-[0_0_0_2px_var(--background)]" />
            )}
          </span>
          <span className="flex-1 truncate">{label}</span>
          {textBadge && (
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
                textBadgeTone === "amber"
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {textBadge}
            </span>
          )}
          {liveCount != null && liveCount > 0 && (
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] font-medium text-status-running">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-running opacity-70" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-status-running" />
              </span>
              {liveCount}
            </span>
          )}
          {badge != null && badge > 0 && (
            <span
              className={cn(
                "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none",
                badgeTone === "danger"
                  ? "bg-status-error text-white"
                  : "bg-primary text-primary-foreground",
              )}
            >
              {badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
