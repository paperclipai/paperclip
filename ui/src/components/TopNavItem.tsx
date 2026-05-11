import { NavLink } from "@/lib/router";
import type { LucideIcon } from "lucide-react";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";

interface TopNavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
}

export function TopNavItem({ to, label, icon: Icon }: TopNavItemProps) {
  return (
    <NavLink
      to={to}
      state={SIDEBAR_SCROLL_RESET_STATE}
      className={({ isActive }) =>
        cn(
          "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition-all",
          isActive
            ? "border-primary/45 bg-primary/[0.16] text-foreground shadow-[0_0_0_1px_rgba(255,159,67,0.08),0_12px_30px_rgba(255,122,26,0.18)]"
            : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/40 hover:text-foreground",
        )
      }
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </NavLink>
  );
}
