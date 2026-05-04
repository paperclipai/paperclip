import { useMemo } from "react";
import { NavLink, useLocation } from "@/lib/router";
import {
  SquarePen,
  BookOpen,
  DollarSign,
  Store,
  ShieldCheck,
  PlusCircle,
} from "lucide-react";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { cn } from "../lib/utils";

interface MobileBottomNavProps {
  visible: boolean;
}

interface MobileNavLinkItem {
  to: string;
  label: string;
  icon: typeof SquarePen;
}

type MobileNavItem = MobileNavLinkItem;

export function MobileBottomNav({ visible }: MobileBottomNavProps) {
  const location = useLocation();

  const items = useMemo<MobileNavItem[]>(
    () => [
      { to: "/daily-work", label: "업무", icon: SquarePen },
      { to: "/quick-capture", label: "기록", icon: PlusCircle },
      { to: "/knowledge", label: "지식", icon: BookOpen },
      { to: "/pnl", label: "정산", icon: DollarSign },
      { to: "/marketplace", label: "마켓", icon: Store },
      { to: "/governance", label: "승인", icon: ShieldCheck },
    ],
    [],
  );

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 transition-transform duration-200 ease-out md:hidden pb-[env(safe-area-inset-bottom)]",
        visible ? "translate-y-0" : "translate-y-full",
      )}
      aria-label="모바일 내비게이션"
    >
      <div className="grid h-16 grid-cols-6 px-1">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.label}
              to={item.to}
              state={SIDEBAR_SCROLL_RESET_STATE}
              className={({ isActive }) =>
                cn(
                  "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", isActive && "stroke-[2.3]")} />
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
