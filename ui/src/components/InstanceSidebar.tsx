import { useQuery } from "@tanstack/react-query";
import { Clock3, Cpu, FlaskConical, Puzzle, Settings, Shield, SlidersHorizontal, UserRoundPen } from "lucide-react";
import { NavLink } from "@/lib/router";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function InstanceSidebar() {
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
      </div>
      <div className="flex items-center gap-2 px-5 pb-3 shrink-0">
        <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1 truncate text-sm font-bold text-foreground">Instance Settings</span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/instance/settings/profile" label="Profile" icon={UserRoundPen} end />
          <SidebarNavItem to="/instance/settings/general" label="General" icon={SlidersHorizontal} end />
          <SidebarNavItem to="/instance/settings/access" label="Access" icon={Shield} end />
          <SidebarNavItem to="/instance/settings/heartbeats" label="Heartbeats" icon={Clock3} end />
          <SidebarNavItem to="/instance/settings/experimental" label="Experimental" icon={FlaskConical} />
          <SidebarNavItem to="/instance/settings/plugins" label="Plugins" icon={Puzzle} />
          <SidebarNavItem to="/instance/settings/adapters" label="Adapters" icon={Cpu} />
          {(plugins ?? []).length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
              {(plugins ?? []).map((plugin) => (
                <NavLink
                  key={plugin.id}
                  to={`/instance/settings/plugins/${plugin.id}`}
                  state={SIDEBAR_SCROLL_RESET_STATE}
                  className={({ isActive }) =>
                    [
                      "rounded-md px-2 py-1.5 text-xs transition-colors",
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    ].join(" ")
                  }
                >
                  {plugin.manifestJson.displayName ?? plugin.packageName}
                </NavLink>
              ))}
            </div>
          ) : null}
        </div>
      </nav>
    </aside>
  );
}
