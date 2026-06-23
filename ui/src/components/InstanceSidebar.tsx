import { useQuery } from "@tanstack/react-query";
import { Clock3, Cpu, FlaskConical, MonitorCog, Puzzle, Settings, Shield, SlidersHorizontal, UserRoundPen } from "lucide-react";
import type { PluginRecord } from "@paperclipai/shared";
import { NavLink } from "@/lib/router";
import { pluginsApi } from "@/api/plugins";
import { useTranslation } from "@/i18n";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { queryKeys } from "@/lib/queryKeys";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { SidebarNavItem } from "./SidebarNavItem";

/**
 * Sandbox-provider-only plugins (e.g. E2B, exe.dev, Modal) have no per-plugin
 * settings page — `PluginSettings` redirects them to the Environments page —
 * so a sidebar entry would lead nowhere useful. Filter them out here. Plugins
 * that mix a sandbox provider with other contributions still appear.
 */
function isSandboxProviderOnly(plugin: PluginRecord): boolean {
  const drivers = plugin.manifestJson.environmentDrivers ?? [];
  if (drivers.length === 0) return false;
  return drivers.every((d) => d.kind === "sandbox_provider");
}

export function InstanceSidebar() {
  const { t } = useTranslation();
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const sidebarPlugins = (plugins ?? []).filter((p) => !isSandboxProviderOnly(p));

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex items-center gap-2 px-3 h-12 shrink-0">
        <Settings className="h-4 w-4 text-muted-foreground shrink-0 ml-1" />
        <span className="flex-1 text-sm font-bold text-foreground truncate">
          {t("components.instanceSidebar.title", { defaultValue: "Instance Settings" })}
        </span>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`} label={t("components.instanceSidebar.navProfile", { defaultValue: "Profile" })} icon={UserRoundPen} end />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/general`} label={t("components.instanceSidebar.navGeneral", { defaultValue: "General" })} icon={SlidersHorizontal} end />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`} label={t("components.instanceSidebar.navEnvironments", { defaultValue: "Environments" })} icon={MonitorCog} end />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/access`} label={t("components.instanceSidebar.navAccess", { defaultValue: "Access" })} icon={Shield} end />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`} label={t("components.instanceSidebar.navHeartbeats", { defaultValue: "Heartbeats" })} icon={Clock3} end />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`} label={t("components.instanceSidebar.navExperimental", { defaultValue: "Experimental" })} icon={FlaskConical} />
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`} label={t("components.instanceSidebar.navPlugins", { defaultValue: "Plugins" })} icon={Puzzle} />
          {sidebarPlugins.length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5 border-l border-border/70 pl-3">
              {sidebarPlugins.map((plugin) => (
                <NavLink
                  key={plugin.id}
                  to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins/${plugin.id}`}
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
          <SidebarNavItem to={`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`} label={t("components.instanceSidebar.navAdapters", { defaultValue: "Adapters" })} icon={Cpu} />
        </div>
      </nav>
    </aside>
  );
}
