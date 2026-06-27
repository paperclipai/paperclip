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
  Package,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  MessagesSquare,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { t, useTranslation } from "@/i18n";

export function Sidebar() {
  const { openNewIssue } = useDialogActions();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
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
  const streamlined = experimentalSettings?.enableStreamlinedLeftNavigation !== false;
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  const expandCollapseLabel = collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar");

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label={t("nav.search")}
              title={t("nav.search")}
            >
              <NavLink to="/search">
                <Search className="h-4 w-4" />
              </NavLink>
            </Button>
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label={t("nav.keepExpanded")}
                  title={t("nav.keepExpanded")}
                  onClick={() => setCollapsed(false)}
                >
                  <Pin className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-expanded={!collapsed}
                  aria-label={expandCollapseLabel}
                  title={expandCollapseLabel}
                  onClick={() => toggleCollapsed()}
                >
                  {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                </Button>
              )
            ) : null}
          </>
        ) : null}
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 pointer-coarse:gap-3 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {(() => {
            const newTaskLabel = t("nav.newTask");
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? newTaskLabel : undefined}
                className="flex items-center gap-2.5 px-3 py-2 pointer-coarse:py-1.5 text-[13px] font-medium text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{newTaskLabel}</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">{newTaskLabel}</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          <SidebarNavItem to="/dashboard" label={t("nav.items.dashboard")} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={t("nav.items.inbox")}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel={t("nav.unread")}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label={t("nav.items.conferenceRoom")} icon={MessagesSquare} />
          ) : null}
        </div>

        <SidebarSection label={t("nav.sections.work")}>
          <SidebarNavItem to="/issues" label={t("nav.items.tasks")} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={t("nav.items.routines")} icon={Repeat} />
          <SidebarNavItem to="/goals" label={t("nav.items.goals")} icon={Target} />
          <SidebarNavItem to="/artifacts" label={t("nav.items.artifacts")} icon={Package} />
          <SidebarNavItem to="/skills" label={t("nav.items.skills")} icon={Boxes} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={t("nav.items.workspaces")} icon={GitBranch} />
          ) : null}
          {streamlined ? (
            <SidebarNavItem to="/projects" label={t("nav.items.projects")} icon={FolderOpen} />
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

        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={t("nav.sections.company")}>
          <SidebarNavItem to="/org" label={t("nav.items.org")} icon={Network} />
          <SidebarNavItem to="/costs" label={t("nav.items.costs")} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("nav.items.activity")} icon={History} />
          <SidebarNavItem to="/company/settings" label={t("nav.items.settings")} icon={Settings} />
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
