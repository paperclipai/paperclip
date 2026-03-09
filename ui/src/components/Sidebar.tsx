import {
  Inbox,
  CircleDot,
  Target,
  FolderOpen,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Settings,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { CompanySwitcher } from "./CompanySwitcher";

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="sidebar-surface flex h-full min-h-0 w-64 flex-col">
      <div className="shrink-0 border-b border-border px-3 pb-3 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <div className="min-w-0">
            <p className="section-kicker">Paperclip OS</p>
            <p className="editorial-title truncate text-[1.55rem] leading-none text-foreground">
              Command center
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-full text-muted-foreground hover:bg-accent/70"
            onClick={openSearch}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>

        <div className="page-frame rounded-[1.1rem] p-2">
          <CompanySwitcher />
          {selectedCompany?.brandColor && (
            <div className="mt-2 flex items-center gap-2 px-2">
              <span
                className="h-2.5 w-2.5 rounded-full border border-white/20"
                style={{ backgroundColor: selectedCompany.brandColor }}
              />
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                Active system
              </span>
            </div>
          )}
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <button
            onClick={() => openNewIssue()}
            className="command-card flex items-center gap-2.5 rounded-[1rem] px-3 py-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-accent/70"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">Open new task</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={sidebarBadges?.inbox}
            badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
            alert={(sidebarBadges?.failedRuns ?? 0) > 0}
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          <SidebarNavItem to="/folders" label="Folders" icon={FolderOpen} />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="System">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
        </SidebarSection>
      </nav>
    </aside>
  );
}
