import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, CloudUpload, KeyRound, MailPlus, MonitorCog, Puzzle, Settings, SlidersHorizontal, Users } from "lucide-react";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ApiError } from "@/api/client";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { usePluginSlots } from "@/plugins/slots";
import { useTranslation } from "@/i18n";
import { SidebarNavItem } from "./SidebarNavItem";

export function CompanySettingsSidebar() {
  const { t } = useTranslation();
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
  const showCloudUpstream = experimentalSettings?.enableCloudSync === true;

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
            {t("nav.sidebar.companySettings.title")}
          </span>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/company/settings" label={t("nav.sidebar.companySettings.general")} icon={SlidersHorizontal} end />
          <SidebarNavItem
            to="/company/settings/environments"
            label={t("nav.sidebar.companySettings.environments")}
            icon={MonitorCog}
            end
          />
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
          <SidebarNavItem to="/company/settings/invites" label={t("nav.sidebar.companySettings.invites")} icon={MailPlus} end />
          <SidebarNavItem to="/company/settings/secrets" label={t("nav.sidebar.companySettings.secrets")} icon={KeyRound} end />
        </div>
      </nav>
    </aside>
  );
}
