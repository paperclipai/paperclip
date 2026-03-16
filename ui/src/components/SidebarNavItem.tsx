import { NavLink } from "@/lib/router";
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
  alert = false,
  liveCount,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <NavLink
      to={to}
      end={end}
      // Close the drawer after navigation so mobile routing keeps the content unobstructed.
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={({ isActive }) =>
        cn(
          "paperclip-nav-link text-[13px] font-medium",
          isActive ? "paperclip-nav-link-active" : "paperclip-nav-link",
          className,
        )
      }
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" />
        {alert && (
          <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
        )}
      </span>
      <span className="flex-1 truncate tracking-[0.01em]">{label}</span>
      {liveCount != null && liveCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="paperclip-nav-meta text-blue-600 dark:text-blue-300">{liveCount} live</span>
        </span>
      )}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "paperclip-nav-meta ml-auto rounded-full px-2 py-0.5 leading-none",
            badgeTone === "danger"
              ? "bg-red-600/90 text-red-50"
              : "paperclip-chip text-primary",
          )}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}
