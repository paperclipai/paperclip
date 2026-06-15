import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  BriefcaseBusiness,
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
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarOrgMenu } from "./SidebarOrgMenu";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";

export function Sidebar() {
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
    <aside className="w-full h-full min-h-0 border-r border-border/60 bg-background/90 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/75 flex flex-col">
      {/* Top bar: Org chip + Company switcher + Search */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarOrgMenu />
        <SidebarCompanyMenu />
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground shrink-0"
          aria-label="Search"
          title="Search"
        >
          <NavLink to="/search">
            <Search className="h-4 w-4" />
          </NavLink>
        </Button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* Capture button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            aria-label="Capture issue"
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">Capture</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/work" label="Work Hub" icon={BriefcaseBusiness} />
          <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label="Workspaces" icon={GitBranch} />
          ) : null}
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Company">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
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
