import { createContext, useContext, type ReactNode } from "react";
import { NavLink } from "@/lib/router";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { LucideIcon } from "lucide-react";

/**
 * Forces the full-label (non-rail) presentation for any `SidebarNavItem`
 * rendered beneath it, regardless of the global `useSidebar().collapsed` state.
 *
 * Takeover routes (PAP-10695) collapse the app `<Sidebar/>` to its 64px rail
 * and render the contextual nav in a fixed 240px `SecondarySidebar`. That pane
 * is always wide enough for labels, but its `SidebarNavItem` children still
 * read the *global* `collapsed=true` and would otherwise render icon-only —
 * leaving the settings nav unreadable (PAP-10700). Wrapping the pane in this
 * provider decouples its items from the global rail collapse.
 */
const SidebarNavExpandedContext = createContext(false);

export function SidebarNavExpandedProvider({ children }: { children: ReactNode }) {
  return (
    <SidebarNavExpandedContext.Provider value={true}>
      {children}
    </SidebarNavExpandedContext.Provider>
  );
}

export function useSidebarNavExpanded() {
  return useContext(SidebarNavExpandedContext);
}

interface SidebarNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  className?: string;
  badge?: number;
  badgeTone?: "default" | "danger";
  /**
   * Accessible noun for the numeric badge when collapsed to the rail, where the
   * count is rendered as a dot (e.g. `badgeLabel="unread"` → "Inbox, 28 unread").
   */
  badgeLabel?: string;
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
  badgeLabel,
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  // A fixed-width contextual pane (SecondarySidebar) forces full labels even
  // when the global app sidebar is collapsed to its rail (PAP-10700).
  const forceExpanded = useSidebarNavExpanded();
  // The icon-only rail presentation only applies when pinned collapsed and not
  // peeking; a peek/expanded panel — or an expanded contextual pane — restores
  // the full label + badge.
  const rail = collapsed && !peeking && !forceExpanded;

  const hasBadge = badge != null && badge > 0;
  const hasLive = liveCount != null && liveCount > 0;

  // Accessible text equivalent for the collapsed dot indicator. The visible
  // label is `sr-only` in the rail, so the count must be surfaced here.
  const railAriaLabel = !rail
    ? undefined
    : hasLive
      ? `${label}, ${liveCount} live`
      : hasBadge
        ? `${label}, ${badge}${badgeLabel ? ` ${badgeLabel}` : ""}`
        : alert
          ? `${label}, attention needed`
          : undefined;

  const link = (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      end={end}
      aria-label={railAriaLabel}
      onClick={() => { if (isMobile) setSidebarOpen(false); }}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" aria-hidden="true" />
        )}
        {/* Collapsed rail: numeric badge / live count collapse to a dot on the
            icon. The icon markup is untouched so it stays pixel-aligned. */}
        {rail && !alert && hasLive && (
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2" aria-hidden="true">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
          </span>
        )}
        {rail && !alert && !hasLive && hasBadge && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full shadow-[0_0_0_2px_hsl(var(--background))]",
              badgeTone === "danger" ? "bg-red-600" : "bg-primary",
            )}
            aria-hidden="true"
          />
        )}
      </span>
      <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "flex-1 truncate"}>{label}</span>
      {!rail && textBadge && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
            textBadgeTone === "amber"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          {textBadge}
        </span>
      )}
      {!rail && hasLive && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{liveCount} live</span>
        </span>
      )}
      {!rail && hasBadge && (
        <span
          className={cn(
            "ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : "bg-primary text-primary-foreground",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );

  if (!rail) return link;

  // The tooltip wraps a plain block element rather than the NavLink directly:
  // Radix `asChild` (Slot) drops React Router's *function* className, which would
  // strip `flex` off the <a> and render it as a block — the in-flow label would
  // then stack under the icon and the row would grow. Anchoring the tooltip to a
  // wrapper keeps the <a> rendering normally (flex), so the row stays 1:1 with
  // the expanded state and the icon never moves (PAP-10676).
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{link}</div>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
