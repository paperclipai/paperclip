import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, MailPlus, MonitorCog, Settings, Shield, SlidersHorizontal } from "lucide-react";
import { sidebarBadgesApi } from "@/api/sidebarBadges";
import { ApiError } from "@/api/client";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { SidebarNavItem } from "./SidebarNavItem";

export function CompanySettingsSidebar() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
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
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/company/settings" label="General" icon={SlidersHorizontal} end />
          <SidebarNavItem
            to="/company/settings/environments"
            label="Environments"
            icon={MonitorCog}
            end
          />
          <SidebarNavItem
            to="/company/settings/access"
            label="Access"
            icon={Shield}
            badge={badges?.joinRequests ?? 0}
            end
          />
          <SidebarNavItem to="/company/settings/invites" label="Invites" icon={MailPlus} end />
        </div>
      </nav>
    </aside>
  );
}
