import type { ReactNode } from "react";
import { NavLink } from "@/lib/router";
import type { IssueNavigationPrefetchHandlers } from "@/hooks/useIssueNavigationPrefetch";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TruncatedText } from "./TruncatedText";

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon?: LucideIcon;
  /**
   * Pre-rendered icon element for rows whose icon isn't a plain Lucide
   * component (e.g. the agent rows' `AgentIcon`). Takes precedence over `icon`;
   * the caller supplies a 16px icon to fit the shared navigation slot.
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
  /** Extra link handlers, such as a task's open-intent prefetch. */
  linkHandlers?: Partial<IssueNavigationPrefetchHandlers>;
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
  linkHandlers,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();
  const hasBadge = badge != null && badge > 0;
  const hasLive = liveCount != null && liveCount > 0;
  const showIconSlot = Boolean(iconNode || Icon || alert);

  return (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      end={end}
      {...linkHandlers}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          // One rhythm and one inset pill highlight: mx-2 floats the row off
          // the sidebar edges, rounded-lg matches the card anchor, px-2 gives
          // the icon breathing room inside the pill. Rows with hover menus
          // (agents/projects) reserve extra right padding via className.
          "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-left text-(length:--text-compact) font-medium transition-colors",
          (active ?? isActive)
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          className,
        )
      }
    >
      {showIconSlot ? (
        <span data-slot="sidebar-nav-icon" className="relative flex size-4 shrink-0 items-center justify-center">
          {iconNode ?? (Icon ? <Icon className="h-4 w-4" /> : null)}
          {alert && (
            <span
              data-slot="sidebar-icon-alert-badge"
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-(--shadow-sidebar-icon-badge)"
              aria-hidden="true"
            />
          )}
        </span>
      ) : null}
      <TruncatedText className={cn("min-w-0 flex-1 truncate", labelClassName)}>{label}</TruncatedText>
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
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap">
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
          aria-label={badgeLabel ? `${badge} ${badgeLabel}` : undefined}
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
