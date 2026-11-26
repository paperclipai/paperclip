import type { ReactNode } from "react";
import { NavLink } from "@/lib/router";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon?: LucideIcon;
  /**
   * Pre-rendered icon element for rows whose icon isn't a plain Lucide
   * component (e.g. the agent rows' `AgentIcon`). Takes precedence over `icon`;
   * the caller owns its sizing/color classes.
   */
  iconNode?: ReactNode;
  end?: boolean;
  className?: string;
  labelClassName?: string;
  badge?: number;
  badgeTone?: "default" | "danger" | "warning";
  badgeLabel?: string;
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
  /**
   * Overrides NavLink's own route matching for rows whose active state is
   * computed externally (agent rows match `/agents/:ref` across tab suffixes).
   */
  active?: boolean;
  /** Rendered after the label, before the right-aligned status cluster. */
  trailing?: ReactNode;
  /** Rendered inside the right-aligned status cluster, before the live dot. */
  liveAccessory?: ReactNode;
}

export function SidebarNavItem({
  to,
  label,
  icon: Icon,
  iconNode,
  end,
  className,
  labelClassName,
  badge,
  badgeTone = "default",
  badgeLabel,
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
  active,
  trailing,
  liveAccessory,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const hasBadge = badge != null && badge > 0;
  const hasLive = liveCount != null && liveCount > 0;

  return (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      end={end}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          // One rhythm and one inset pill highlight: mx-2 floats the row off
          // the sidebar edges, rounded-lg matches the card anchor, px-2 gives
          // the icon breathing room inside the pill. Rows with hover menus
          // (agents/projects) reserve extra right padding via className.
          "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors",
          (active ?? isActive)
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        {iconNode ?? (Icon ? <Icon className="h-4 w-4" /> : null)}
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-(--shadow-extract-12)" aria-hidden="true" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", labelClassName)}>{label}</span>
      {trailing}
      {textBadge && (
        <Badge variant="ghost"
          className={cn(
            "ml-auto px-1.5 text-(length:--text-nano) leading-none",
            textBadgeTone === "amber"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </Badge>
      )}
      {(hasLive || liveAccessory) && (
        <span className="ml-auto flex items-center gap-1.5">
          {liveAccessory}
          {hasLive && (
            <>
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-600 dark:bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600 dark:bg-blue-400" />
              </span>
              <span className="text-(length:--text-micro) font-medium text-blue-600 dark:text-blue-400">{liveCount} live</span>
            </>
          )}
        </span>
      )}
      {hasBadge && (
        <Badge variant="ghost"
          className={cn(
            "ml-auto px-1.5 leading-none",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : badgeTone === "warning"
                ? "bg-amber-500/90 text-amber-50"
                : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </Badge>
      )}
    </NavLink>
  );
}
