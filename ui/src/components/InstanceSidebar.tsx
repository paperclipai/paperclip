import { Clock3, Settings } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";

export function InstanceSidebar() {
  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex items-center gap-2 px-3 h-12 shrink-0">
        <Settings className="h-4 w-4 text-muted-foreground shrink-0 ml-1" />
        <span className="flex-1 text-sm font-bold text-foreground truncate">
          Instance Settings
        </span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/instance/settings" label="Heartbeats" icon={Clock3} />
        </div>
      </nav>
    </aside>
  );
}
