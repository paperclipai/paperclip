import {
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  DollarSign,
  History,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  GitBranch,
  Package,
  Settings,
  Sparkles,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";

export function Sidebar() {
  const { openNewIssue } = useDialog();
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
  const showWorkspacesLink =
    experimentalSettings?.enableIsolatedWorkspaces === true;
  const showBuilderLink = experimentalSettings?.builderEnabled === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="brand-shell flex h-full min-h-0 w-72 flex-col border-r border-sidebar-border bg-sidebar/95">
      <div className="flex shrink-0 items-center gap-2 px-4 py-4">
        <SidebarCompanyMenu />
      </div>

      <nav className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
        <div className="brand-panel-subtle flex flex-col gap-1 rounded-[1.35rem] p-2">
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 rounded-2xl bg-[linear-gradient(135deg,rgba(255,174,82,0.22),rgba(255,120,32,0.14))] px-3 py-2.5 text-[13px] font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-all hover:brightness-110"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">Create New Issue</span>
          </button>
          <SidebarNavItem
            to="/dashboard"
            label="Dashboard"
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
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

        <SidebarSection label="Workflows">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem
            to="/deliverables"
            label="Deliverables"
            icon={Package}
          />
          <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem
              to="/workspaces"
              label="Workspaces"
              icon={GitBranch}
            />
          ) : null}
          {showBuilderLink ? (
            <SidebarNavItem to="/builder" label="AI Builder" icon={Sparkles} />
          ) : null}
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Company Ops">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem
            to="/company/settings"
            label="Settings"
            icon={Settings}
          />
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
