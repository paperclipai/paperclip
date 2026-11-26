import { Fragment, useEffect, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { cn } from "@/lib/utils";

export interface MobileContextualNavItem {
  key: string;
  to: string;
  label: string;
  icon?: LucideIcon;
  end?: boolean;
  badge?: number;
  badgeTone?: "default" | "danger";
  badgeLabel?: string;
}

export interface MobileContextualNavGroup {
  key: string;
  items: readonly MobileContextualNavItem[];
}

export function MobileContextualNav({
  surface,
  ariaLabel,
  groups,
  className,
}: {
  surface: string;
  ariaLabel: string;
  groups: readonly MobileContextualNavGroup[];
  className?: string;
}) {
  const location = useLocation();
  const navRef = useRef<HTMLElement | null>(null);
  const visibleGroups = groups.filter((group) => group.items.length > 0);
  const itemSignature = visibleGroups
    .flatMap((group) => group.items.map((item) => item.to))
    .join("|");

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (typeof active?.scrollIntoView === "function") {
      active.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }, [location.pathname, itemSignature]);

  if (visibleGroups.length === 0) return null;

  return (
    <div className={cn("border-b border-border bg-background", className)}>
      <nav
        ref={navRef}
        aria-label={ariaLabel}
        data-mobile-contextual-nav={surface}
        className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-auto-hide px-3 py-1.5"
      >
        {visibleGroups.map((group, groupIndex) => (
          <Fragment key={group.key}>
            {groupIndex > 0 ? (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            ) : null}
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.key}
                  to={item.to}
                  end={item.end}
                  state={SIDEBAR_SCROLL_RESET_STATE}
                  className={({ isActive }) =>
                    cn(
                      "inline-flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )
                  }
                >
                  {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
                  <span>{item.label}</span>
                  {item.badge != null && item.badge > 0 ? (
                    <Badge
                      variant={item.badgeTone === "danger" ? "destructive" : "secondary"}
                      aria-label={item.badgeLabel ? `${item.badge} ${item.badgeLabel}` : undefined}
                      className="px-1.5 py-0 text-(length:--text-nano) leading-tight tabular-nums"
                    >
                      {item.badge > 99 ? "99+" : item.badge}
                    </Badge>
                  ) : null}
                </NavLink>
              );
            })}
          </Fragment>
        ))}
      </nav>
    </div>
  );
}
