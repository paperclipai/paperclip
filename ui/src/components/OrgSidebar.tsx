import { LayoutDashboard } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";

export function OrgSidebar() {
  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <span className="flex-1 text-sm font-bold text-foreground pl-1 mt-1">
          Organisation
        </span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/org/dashboard" label="Dashboard" icon={LayoutDashboard} />
        </div>
      </nav>
    </aside>
  );
}
