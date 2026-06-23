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
import { useTranslation } from "@/i18n";

export function Sidebar() {
  const { t } = useTranslation();
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
  // IA flag: branch the sidebar nav presentation. Default ON =
  // streamlined (top-level Projects link). Users can opt out in experiments to
  // get classic (per-project collapsible, no Projects nav link). Issue/Task
  // wording is split to PR #7651. Gating is navigation-only; all routes stay
  // registered in both modes.
  const streamlined = experimentalSettings?.enableStreamlinedLeftNavigation !== false;
  // Conference Room Chat flag (PAP-136/PAP-137): the Conference Room nav item
  // is a new surface, hidden entirely while the flag is off (same no-flash
  // pattern as showWorkspacesLink above).
  const conferenceRoomChatEnabled = experimentalSettings?.enableConferenceRoomChat === true;

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
        <SidebarCompanyMenu />
        {/* In the collapsed rail the search/toggle controls don't fit beside the
            logo — keeping them would overflow the 64px rail and squeeze the logo
            out of alignment with the icon column below it (PAP-10676). They return
            as soon as the panel is expanded (pinned) or peeking. Expansion in the
            rail is still reachable via hover-peek + Pin and Cmd/Ctrl+B. */}
        {!rail ? (
          <>
            <Button
              asChild
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground shrink-0"
              aria-label={t("common.openSearch", { defaultValue: "Open search" })}
              title={t("common.openSearch", { defaultValue: "Open search" })}
            >
              <NavLink to="/search">
                <Search className="h-4 w-4" />
              </NavLink>
            </Button>
            {/* Desktop-only collapse/expand affordance. While peeking (hover flyout
                over the collapsed rail) it becomes a Pin that promotes the peek to a
                pinned-expanded sidebar; otherwise it toggles the pinned rail. Mobile
                uses the off-canvas drawer, so this control is hidden there. It is
                also hidden while a secondary sidebar forces the rail (collapseLocked):
                the user cannot expand the primary while a secondary sidebar is shown. */}
            {!isMobile && !collapseLocked ? (
              peeking ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground shrink-0"
                  aria-label={t("nav.keepExpanded", { defaultValue: "Keep sidebar expanded" })}
                  title={t("nav.keepExpanded", { defaultValue: "Keep sidebar expanded" })}
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
                  aria-label={
                    collapsed
                      ? t("nav.expandSidebar", { defaultValue: "Expand sidebar" })
                      : t("nav.collapseSidebar", { defaultValue: "Collapse sidebar" })
                  }
                  title={
                    collapsed
                      ? t("nav.expandSidebar", { defaultValue: "Expand sidebar" })
                      : t("nav.collapseSidebar", { defaultValue: "Collapse sidebar" })
                  }
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
          {/* New Task button aligned with nav items */}
          {(() => {
            const newTaskLabel = t("nav.newTask", { defaultValue: "New Task" });
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
          <SidebarNavItem
            to="/dashboard"
            label={t("nav.dashboard", { defaultValue: "Dashboard" })}
            icon={LayoutDashboard}
            liveCount={liveRunCount}
          />
          <SidebarNavItem
            to="/inbox"
            label={t("nav.inbox", { defaultValue: "Inbox" })}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel="unread"
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem
              to="/board-chat"
              label={t("nav.conferenceRoom", { defaultValue: "Conference Room" })}
              icon={MessagesSquare}
            />
          ) : null}
        </div>

        <SidebarSection label={t("nav.sections.work", { defaultValue: "Work" })}>
          <SidebarNavItem to="/issues" label={t("nav.items.tasks", { defaultValue: "Tasks" })} icon={CircleDot} />
          <SidebarNavItem to="/routines" label={t("nav.items.routines", { defaultValue: "Routines" })} icon={Repeat} />
          <SidebarNavItem to="/goals" label={t("nav.items.goals", { defaultValue: "Goals" })} icon={Target} />
          <SidebarNavItem to="/artifacts" label={t("nav.items.artifacts", { defaultValue: "Artifacts" })} icon={Package} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={t("nav.items.workspaces", { defaultValue: "Workspaces" })} icon={GitBranch} />
          ) : null}
          {streamlined ? (
            <SidebarNavItem to="/projects" label={t("nav.items.projects", { defaultValue: "Projects" })} icon={FolderOpen} />
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

        {/* Classic mode restores the per-project collapsible below Work. */}
        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={t("nav.sections.company", { defaultValue: "Company" })}>
          <SidebarNavItem to="/org" label={t("nav.items.org", { defaultValue: "Org" })} icon={Network} />
          <SidebarNavItem to="/skills" label={t("nav.items.skills", { defaultValue: "Skills" })} icon={Boxes} />
          <SidebarNavItem to="/costs" label={t("nav.items.costs", { defaultValue: "Costs" })} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("nav.items.activity", { defaultValue: "Activity" })} icon={History} />
          <SidebarNavItem to="/company/settings" label={t("nav.items.settings", { defaultValue: "Settings" })} icon={Settings} />
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
