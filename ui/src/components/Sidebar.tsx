import {
  Inbox,
  ListChecks,
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
  Layers,
  GitBranch,
  Package,
  Settings,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  AppWindow,
  MessagesSquare,
  GanttChartSquare,
} from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarStarredProjects } from "./SidebarStarredProjects";
import { useDialogActions } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { attentionApi } from "../api/attention";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { attentionBadgeCount } from "../lib/attention";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { useTranslation } from "react-i18next";

export function Sidebar() {
  const { t } = useTranslation();
  const { openNewIssue } = useDialogActions();
  // Every labeled section is collapsible (session-scoped, default open) —
  // one policy across static nav groups and the data-driven sections.
  const [workOpen, setWorkOpen] = useState(true);
  const [companyOpen, setCompanyOpen] = useState(true);
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const rail = collapsed && !peeking;
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (#9627) + reconnect reconcile — no
    // interval poll needed. Polling here also re-armed React Query's timer on
    // every live-event cache write, a major source of steady-state churn.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const liveRunCount = liveRuns?.length ?? 0;
  const showWorkspacesLink = experimentalSettings?.enableIsolatedWorkspaces === true;
  const showApps = experimentalSettings?.enableApps === true;
  const showPipelines = experimentalSettings?.enablePipelines === true;
  const goalsLinkPending = experimentalSettings === undefined;
  const showGoalsLink = experimentalSettings?.enableGoalsSidebarLink === true;
  // Decisions (attention home) is an experimental surface (PAP-13481): the nav
  // item is hidden entirely until the flag is enabled (same no-flash pattern as
  // showWorkspacesLink — it defaults hidden, so no placeholder is needed).
  const showDecisions = experimentalSettings?.enableDecisions === true;
  const { data: attentionFeed } = useQuery({
    queryKey: queryKeys.attention(selectedCompanyId!),
    queryFn: () => attentionApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && showDecisions,
    refetchInterval: 60_000,
  });
  const attentionCount = attentionBadgeCount(attentionFeed);
  const showCases = experimentalSettings?.enableCases === true;
  // Streamlined left navigation (top-level Projects link + starred children) is
  // now the standard product sidebar (PAP-12472). The former experimental
  // opt-out was retired; classic per-project collapsible mode is no longer
  // user-selectable. Kept as a constant so the classic branch below stays as a
  // documented reference until it is fully removed. Routes are unaffected.
  const streamlined = true;
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
              aria-label={t("navigation.openSearch")}
              title={t("navigation.openSearch")}
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
                  aria-label={t("navigation.keepSidebarExpanded")}
                  title={t("navigation.keepSidebarExpanded")}
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
                  aria-label={collapsed ? t("navigation.expandSidebar") : t("navigation.collapseSidebar")}
                  title={collapsed ? t("navigation.expandSidebar") : t("navigation.collapseSidebar")}
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
            const newTaskButton = (
              <button
                onClick={() => openNewIssue()}
                data-slot="icon-button"
                aria-label={rail ? t("navigation.newTask") : undefined}
                className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-foreground/80 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <SquarePen className="h-4 w-4 shrink-0" />
                <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : "truncate"}>{t("navigation.newTask")}</span>
              </button>
            );
            return rail ? (
              <Tooltip>
                <TooltipTrigger asChild>{newTaskButton}</TooltipTrigger>
                <TooltipContent side="right">{t("navigation.newTask")}</TooltipContent>
              </Tooltip>
            ) : (
              newTaskButton
            );
          })()}
          <SidebarNavItem to="/dashboard" label={t("navigation.dashboard")} icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label={t("navigation.inbox")}
            icon={Inbox}
            badge={inboxBadge.inbox}
            badgeLabel={t("common.unread")}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          {showDecisions ? (
            <SidebarNavItem
              to="/decisions"
              label="Decisions"
              icon={ListChecks}
              badge={attentionCount}
              badgeLabel="decisions"
            />
          ) : null}
          {conferenceRoomChatEnabled ? (
            <SidebarNavItem to="/board-chat" label={t("navigation.conferenceRoom")} icon={MessagesSquare} />
          ) : null}
        </div>

        <SidebarSection label={t("navigation.work")} collapsible={{ open: workOpen, onOpenChange: setWorkOpen }}>
          <SidebarNavItem to="/issues" label={t("navigation.tasks")} icon={CircleDot} />
          {showCases ? (
            <SidebarNavItem to="/cases" label={t("navigation.cases")} icon={Layers} textBadge="beta" />
          ) : null}
          <SidebarNavItem to="/routines" label={t("navigation.routines")} icon={Repeat} />
          {showPipelines ? (
            <SidebarNavItem to="/pipelines" label={t("navigation.pipelines")} icon={GitBranch} />
          ) : null}
          {showGoalsLink ? (
            <SidebarNavItem to="/goals" label={t("navigation.goals")} icon={Target} />
          ) : goalsLinkPending ? (
            <div
              data-testid="sidebar-goals-placeholder"
              className="h-8 pointer-coarse:h-7"
              aria-hidden="true"
            />
          ) : null}
          <SidebarNavItem to="/artifacts" label={t("navigation.artifacts")} icon={Package} />
          <SidebarNavItem to="/skills" label={t("navigation.skills")} icon={Boxes} />
          {showWorkspacesLink ? (
            <SidebarNavItem to="/workspaces" label={t("navigation.workspaces")} icon={GitBranch} />
          ) : null}
          {streamlined ? (
            <>
              <SidebarNavItem to="/projects" label={t("navigation.projects")} icon={FolderOpen} />
              <SidebarStarredProjects />
            </>
          ) : null}
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </SidebarSection>

        {/* Classic mode restores the per-project collapsible below Work. */}
        {streamlined ? null : <SidebarProjects />}

        <SidebarAgents streamlined={streamlined} />

        <SidebarSection label={t("navigation.company")} collapsible={{ open: companyOpen, onOpenChange: setCompanyOpen }}>
          <SidebarNavItem to="/org" label={t("navigation.org")} icon={Network} />
          {showApps ? <SidebarNavItem to="/apps" label={t("navigation.apps")} icon={AppWindow} /> : null}
          <SidebarNavItem to="/timeline" label={t("navigation.timeline")} icon={GanttChartSquare} />
          <SidebarNavItem to="/costs" label={t("navigation.costs")} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("navigation.activity")} icon={History} />
          <SidebarNavItem to="/company/settings" label={t("navigation.settings")} icon={Settings} />
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
