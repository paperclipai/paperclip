import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  Search,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Settings,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { useLocalizedCopy } from "@/i18n/ui-copy";

export function Sidebar() {
  const copy = useLocalizedCopy();
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label={copy("sidebar.search.open", "Open search", "검색 열기")}
          title={copy("sidebar.search.open", "Open search", "검색 열기")}
        >
          <NavLink to="/search">
            <Search className="h-4 w-4" />
          </NavLink>
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            data-slot="icon-button"
            className="flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">{copy("sidebar.nav.newIssue", "New Issue", "새 작업")}</span>
          </button>
          <SidebarNavItem to="/dashboard" label={copy("sidebar.nav.dashboard", "Dashboard", "대시보드")} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={copy("sidebar.nav.inbox", "Inbox", "받은함")}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
        </div>

        <SidebarSection label={copy("sidebar.section.work", "Work", "업무")}>
          <SidebarNavItem to="/issues" label={copy("sidebar.nav.issues", "Issues", "작업")} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={copy("sidebar.nav.routines", "Routines", "루틴")} icon={Repeat} />
          <SidebarNavItem to="/goals" label={copy("sidebar.nav.goals", "Goals", "목표")} icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={copy("sidebar.nav.workspaces", "Workspaces", "작업공간")} icon={GitBranch} />
          ) : null}
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
          />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label={copy("sidebar.section.company", "Company", "회사")}>
          <SidebarNavItem to="/org" label={copy("sidebar.nav.org", "Org", "조직")} icon={Network} />
          <SidebarNavItem to="/skills" label={copy("sidebar.nav.skills", "Skills", "스킬")} icon={Boxes} />
          <SidebarNavItem to="/costs" label={copy("sidebar.nav.costs", "Costs", "비용")} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={copy("sidebar.nav.activity", "Activity", "활동")} icon={History} />
          <SidebarNavItem to="/company/settings" label={copy("sidebar.nav.settings", "Settings", "설정")} icon={Settings} />
        </SidebarSection>

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="rounded-lg border border-border p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
