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
import { useTranslation } from "@/i18n";
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

export function Sidebar() {
  const { t } = useTranslation();
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
          aria-label={t("top.openSearch", { ns: "sidebar", defaultValue: "Open search" })}
          title={t("top.openSearch", { ns: "sidebar", defaultValue: "Open search" })}
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
            <span className="truncate">{t("top.newIssue", { ns: "sidebar", defaultValue: "New Issue" })}</span>
          </button>
          <SidebarNavItem
            to="/dashboard"
            label={t("nav.dashboard", { ns: "sidebar", defaultValue: "Dashboard" })}
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
          <SidebarNavItem
            to="/inbox"
            label={t("nav.inbox", { ns: "sidebar", defaultValue: "Inbox" })}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
        </div>

        <SidebarSection label={t("sections.work", { ns: "sidebar", defaultValue: "Work" })}>
          <SidebarNavItem to="/issues" label={t("nav.issues", { ns: "sidebar", defaultValue: "Issues" })} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={t("nav.routines", { ns: "sidebar", defaultValue: "Routines" })} icon={Repeat} />
          <SidebarNavItem to="/goals" label={t("nav.goals", { ns: "sidebar", defaultValue: "Goals" })} icon={Target} />
          {showWorkspacesLink ? (
            <SidebarNavItem
              to="/workspaces"
              label={t("nav.workspaces", { ns: "sidebar", defaultValue: "Workspaces" })}
              icon={GitBranch}
            />
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

        <SidebarSection label={t("sections.company", { ns: "sidebar", defaultValue: "Company" })}>
          <SidebarNavItem to="/org" label={t("nav.org", { ns: "sidebar", defaultValue: "Org" })} icon={Network} />
          <SidebarNavItem to="/skills" label={t("nav.skills", { ns: "sidebar", defaultValue: "Skills" })} icon={Boxes} />
          <SidebarNavItem to="/costs" label={t("nav.costs", { ns: "sidebar", defaultValue: "Costs" })} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("nav.activity", { ns: "sidebar", defaultValue: "Activity" })} icon={History} />
          <SidebarNavItem to="/company/settings" label={t("nav.settings", { ns: "sidebar", defaultValue: "Settings" })} icon={Settings} />
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
