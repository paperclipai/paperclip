import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  Clock3,
  CloudUpload,
  Cpu,
  FlaskConical,
  KeyRound,
  MailPlus,
  MonitorCog,
  Puzzle,
  Settings,
  Shield,
  SlidersHorizontal,
  UserRoundPen,
  Users,
} from "lucide-react";
import type { PluginRecord } from "@paperclipai/shared";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { pluginsApi } from "@/api/plugins";
import { ApiError } from "@/api/client";
import { Link, NavLink } from "@/lib/router";
import { INSTANCE_SETTINGS_PATH_PREFIX } from "@/lib/instance-settings";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { usePluginSlots } from "@/plugins/slots";
import { SidebarNavItem } from "./SidebarNavItem";

/**
 * Sandbox-provider-only plugins (e.g. E2B, exe.dev, Modal) have no per-plugin
 * settings page, so a sidebar entry would lead nowhere useful. Filter them out
 * here. Plugins that mix a sandbox provider with other contributions still
 * appear.
 */
function isSandboxProviderOnly(plugin: PluginRecord): boolean {
  const drivers = plugin.manifestJson.environmentDrivers ?? [];
  if (drivers.length === 0) return false;
  return drivers.every((d) => d.kind === "sandbox_provider");
}

export function CompanySettingsSidebar() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { slots: companySettingsPluginSlots } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });
  const { data: badges } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.sidebarBadges(selectedCompanyId)
      : ["sidebar-badges", "__disabled__"] as const,
    queryFn: async () => {
      try {
        return await sidebarBadgesApi.get(selectedCompanyId!);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!selectedCompanyId,
    retry: false,
    refetchInterval: 15_000,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const showCloudUpstream = experimentalSettings?.enableCloudSync === true;
  const sidebarPlugins = (plugins ?? []).filter((plugin) => !isSandboxProviderOnly(plugin));

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <Link
          to="/dashboard"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? "Company"}</span>
        </Link>
        <div className="flex items-center gap-2 px-2 py-1">
          <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-bold text-foreground">
            Company Settings
          </span>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Company settings
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/company/settings" label="General" icon={SlidersHorizontal} end />
          {showCloudUpstream ? (
            <SidebarNavItem
              to="/company/settings/cloud-upstream"
              label="Cloud upstream"
              icon={CloudUpload}
              end
            />
          ) : null}
          <SidebarNavItem
            to="/company/settings/members"
            label="Members"
            icon={Users}
            badge={badges?.joinRequests ?? 0}
            end
          />
          {companySettingsPluginSlots
            .filter((slot) => slot.routePath)
            .map((slot) => (
              <SidebarNavItem
                key={`${slot.pluginKey}:${slot.id}`}
                to={`/company/settings/${slot.routePath}`}
                label={slot.displayName}
                icon={Puzzle}
                end
              />
            ))}
          <SidebarNavItem to="/company/settings/invites" label="Invites" icon={MailPlus} end />
          <SidebarNavItem to="/company/settings/secrets" label="Secrets" icon={KeyRound} end />
        </div>
        <div className="mt-5 px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Instance settings
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/profile`}
            label="Profile"
            icon={UserRoundPen}
            end
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/general`}
            label="General"
            icon={SlidersHorizontal}
            end
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/environments`}
            label="Environments"
            icon={MonitorCog}
            end
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/access`}
            label="Access"
            icon={Shield}
            end
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/heartbeats`}
            label="Heartbeats"
            icon={Clock3}
            end
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/experimental`}
            label="Experimental"
            icon={FlaskConical}
          />
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/plugins`}
            label="Plugins"
            icon={Puzzle}
          />
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
          <SidebarNavItem
            to={`${INSTANCE_SETTINGS_PATH_PREFIX}/adapters`}
            label="Adapters"
            icon={Cpu}
          />
        </div>
      </nav>
    </aside>
  );
}
