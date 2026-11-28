import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Boxes, CircleCheck, Compass, Folder, History, LayoutDashboard, MessageCircle, MoreHorizontal, Network, Plus, Repeat, Search, Settings, SquarePen, Unplug, type LucideIcon } from "lucide-react";
import type { Agent, IssueSummary, Project } from "@paperclipai/shared";
import { useCoordinatorAttentionCount } from "@/hooks/useCoordinatorAttentionCount";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useResponsibilitiesEnabled } from "@/hooks/useResponsibilitiesEnabled";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useRecentTaskOpenWarmup } from "@/hooks/useRecentTaskOpenWarmup";
import { projectPinKey, usePinnedNavigation } from "@/hooks/usePinnedNavigation";
import { useDialogActions } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { PluginSlotOutlet } from "@/plugins/slots";
import { queryKeys } from "@/lib/queryKeys";
import type { RecentTaskEntry } from "@/lib/recent-tasks";
import { Link, useLocation } from "@/lib/router";
import { agentRouteRef, projectRouteRef } from "@/lib/utils";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { RecentTaskNavItem, recentTaskPathRef } from "./RecentTaskNavItem";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { useScrollbarWhileScrolling } from "./side-panel/use-scrollbar-while-scrolling";
import { Flyout, FlyoutContent, FlyoutTrigger, FlyoutAppearanceProvider } from "./ui/flyout";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { AgentAvatar } from "./AgentAvatar";
import { agentChatPinKey } from "./AgentChatPin";
import { PinnedNavigationList, type PinnedNavigationItem } from "./PinnedNavigationList";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { NavigationPinButton, type PinControls } from "./NavigationPinButton";
import { SidebarProjectTasks } from "./SidebarProjectTasks";

const NO_RECENT_TASKS: never[] = [];
const TASK_PIN_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const taskPinKey = (companyId: string, id: string) => `task:${companyId}:${id}`;

const moreDestinations = [
  { label: "Search", to: "/search", icon: Search },
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", to: "/projects", icon: Folder },
  { label: "Routines", to: "/routines", icon: Repeat },
  { label: "Artifacts", to: "/artifacts", icon: Boxes },
  { label: "Agents", to: "/agents/all", icon: Network },
  { label: "Skills", to: "/skills", icon: Boxes },
  { label: "Plugins", to: "/apps", icon: Unplug },
  { label: "Audit", to: "/activity", icon: History },
  { label: "Settings", to: "/settings", icon: Settings },
] as const;

export function buildPinnedNavigationItems(
  pins: readonly string[],
  agents: readonly Agent[],
  destinations: readonly { to: string; label: string; icon: LucideIcon }[],
  tasks: readonly IssueSummary[] = [],
  projects: readonly Project[] = [],
): PinnedNavigationItem[] {
  if (!pins.length) return [];
  const keys = new Set(pins);
  const items = new Map<string, PinnedNavigationItem>(destinations.map(item => [item.to, { key: item.to, to: item.to, label: item.label, icon: <item.icon className="size-4" /> }]));
  for (const agent of agents) {
    const key = agentChatPinKey(agent.companyId, agent.id);
    if (keys.has(key)) items.set(key, { key, to: `/chats/${encodeURIComponent(agentRouteRef(agent))}`, label: agent.name, icon: <AgentAvatar agent={agent} size={16} /> });
  }
  for (const task of tasks) {
    const key = taskPinKey(task.companyId, task.id);
    if (keys.has(key)) items.set(key, { key, to: `/issues/${recentTaskPathRef(task)}`, label: task.title, icon: <StatusIcon {...taskStatusIconProps(task)} />, task });
  }
  for (const project of projects) {
    const key = projectPinKey(project);
    if (keys.has(key)) items.set(key, { key, label: project.name, project });
  }
  return pins.flatMap(key => {
    const item = items.get(key);
    return item ? [item] : [];
  });
}

type RecentTaskLink = Omit<RecentTaskEntry, "recordedAt">;

function RecentPinRow({ pinKey, label, pins, children }: { pinKey: string; label: string; pins: PinControls; children: ReactNode }) {
  if (!pins.canPin) return <>{children}</>;
  return <div className="design-sidebar-pin-target relative min-w-0">
    {children}
    <NavigationPinButton pinKey={pinKey} label={label} pins={pins} className="absolute right-3 top-1/2 size-7 -translate-y-1/2" />
  </div>;
}

function RecentTaskPinRow({ task, pins }: { task: RecentTaskLink; pins: PinControls }) {
  return <RecentPinRow pinKey={taskPinKey(task.companyId, task.id)} label={task.title} pins={pins}>
    <RecentTaskNavItem className="design-sidebar-item" task={task} label={task.title} iconNode={<StatusIcon {...taskStatusIconProps(task)} />} />
  </RecentPinRow>;
}

function RecentNavigationList({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const handleScroll = useScrollbarWhileScrolling();
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      viewport.dataset.overflowTop = String(viewport.scrollTop > 1);
      viewport.dataset.overflowBottom = String(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1);
    };
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => { viewport.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
  return <div ref={scrollRef} className="design-sidebar-recent-list scrollbar-while-scrolling" onScroll={handleScroll} role="region" aria-label="Recents" tabIndex={0}>
    <div ref={contentRef} className="design-sidebar-recent-content">{children}</div>
  </div>;
}

/** The navigation is a view of the existing records; it never creates a chat
 * or task just because someone visits or switches agents. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };
  const unreadChatCount = chats.data?.filter(chat => chat.isUnreadForMe).length ?? 0;
  const pinnedNavigation = usePinnedNavigation(userId);
  const pinnedTaskIds = useMemo(() => {
    if (!companyId || !session.isSuccess) return [];
    const prefix = taskPinKey(companyId, "");
    return pinnedNavigation.pins.flatMap(key => {
      if (!key.startsWith(prefix)) return [];
      const id = key.slice(prefix.length);
      return TASK_PIN_ID_PATTERN.test(id) ? [id] : [];
    });
  }, [companyId, pinnedNavigation.pins, session.isSuccess]);
  const { data: experimental } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // Responsibilities (experimental) is home, named Dashboard, and leads Chat,
  // Tasks and Inbox. The classic dashboard leaves More: one Dashboard at a time.
  const { enabled: responsibilitiesHome } = useResponsibilitiesEnabled();
  const destinations = useMemo(() => {
    const base = responsibilitiesHome
      ? moreDestinations.filter((item) => item.to !== "/dashboard")
      : moreDestinations;
    return experimental?.enableCases ? [...base, { label: "Cases", to: "/cases", icon: Boxes }] : base;
  }, [experimental?.enableCases, responsibilitiesHome]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const moreContentRef = useRef<HTMLDivElement>(null);
  const { entries: recentTasks, pinnedTasks } = useRecentTasks({ companyId, userId, pinnedTaskIds });
  const { isMobile, setSidebarOpen } = useSidebar();
  // Warm opens only while the Recents list is on screen.
  const location = useLocation();
  useRecentTaskOpenWarmup({ companyId, userId, tasks: session.isSuccess ? recentTasks : NO_RECENT_TASKS, navigationKey: location.pathname });
  const { openNewIssue } = useDialogActions();
  const attentionCount = useCoordinatorAttentionCount(companyId);
  const { data: projects } = useQuery({ ...companyProjectsQuery(companyId!), enabled: !!companyId });
  const orderedPins = useMemo(() => buildPinnedNavigationItems(pinnedNavigation.pins, agents.data ?? [], destinations,
    pinnedTasks, session.isSuccess ? projects : undefined), [pinnedNavigation.pins, agents.data, destinations, pinnedTasks, projects, session.isSuccess]);
  // Only project IDs and visit times are kept in memory. Labels and task lists
  // always come from the authorized API, scoped to the current person/company.
  const scope = `${companyId}:${userId}`;
  const [projectVisits, setProjectVisits] = useState<{ scope: string; entries: Record<string, number> }>({ scope, entries: {} });
  useEffect(() => {
    const ref = location.pathname.match(/\/projects\/([^/]+)/)?.[1];
    const project = projects?.find(item => item.id === ref || projectRouteRef(item) === ref);
    if (!project) return;
    setProjectVisits(previous => ({ scope, entries: { ...(previous.scope === scope ? previous.entries : {}), [project.id]: Date.now() } }));
  }, [location.pathname, projects, scope]);
  const recents = useMemo(() => {
    const roster = new Map((agents.data ?? []).map(agent => [agent.id, agent]));
    const taskRows = recentTasks.map(task => ({ kind: "task" as const, id: task.id, time: task.recordedAt, task }));
    const chatRows = (chats.data ?? []).flatMap(chat => {
      const agent = chat.conversationAgentId ? roster.get(chat.conversationAgentId) : null;
      return agent ? [{ kind: "chat" as const, id: chat.id, time: new Date(chat.updatedAt).getTime(), agent }] : [];
    });
    const projectRows = (projects ?? []).flatMap(project => projectVisits.scope === scope && projectVisits.entries[project.id]
      ? [{ kind: "project" as const, id: project.id, time: projectVisits.entries[project.id]!, project }] : []);
    return [...taskRows, ...chatRows, ...projectRows].sort((a, b) => b.time - a.time);
  }, [agents.data, chats.data, recentTasks, projects, projectVisits, scope]);
  const newTaskButton = <Button type="button" variant="ghost" className="design-sidebar-new-task rounded-lg" aria-label="New task" onClick={() => openNewIssue()}>
    <SquarePen aria-hidden />
    <span className="truncate">New task</span>
  </Button>;
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><aside className="coordinator-sidebar design-sidebar w-full">
    <div className="design-sidebar-brand">
      <SidebarCompanyMenu showChevron={false} />
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label="Global search" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">Search tasks, agents, projects</TooltipContent></Tooltip>
    </div>
    <nav className="design-sidebar-navigation" aria-label="Workspace navigation">
      <div className="design-sidebar-primary">
        {newTaskButton}
        <div className="design-sidebar-primary my-2">
          {responsibilitiesHome && <SidebarNavItem className="design-sidebar-item" to="/responsibilities" label="Dashboard" icon={Compass} />}
          <SidebarNavItem className="design-sidebar-item" to="/chats" label="Chat" icon={MessageCircle} badge={unreadChatCount} badgeLabel="unread chats" />
          <div className="group/coordinator-new relative">
            <SidebarNavItem to="/issues" label="Tasks" icon={CircleCheck} className="design-sidebar-item pr-9" />
            <button type="button" aria-label="New task" title="New task" onClick={() => openNewIssue()}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/coordinator-new:opacity-100 group-focus-within/coordinator-new:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" /></button>
          </div>
          <SidebarNavItem className="design-sidebar-item" to="/decisions" label="Inbox" icon={Inbox} badge={attentionCount} badgeLabel="decisions" />
          {orderedPins.length > 0 && <PinnedNavigationList key={`${companyId}:${userId}`} items={orderedPins} userId={userId} onReorder={pinnedNavigation.reorder} onUnpin={pinnedNavigation.toggle} />}
        </div>
        <PluginSlotOutlet
          slotTypes={["sidebar"]}
          context={pluginContext}
          className="my-2 flex flex-col gap-0.5"
          itemClassName="design-sidebar-item"
          missingBehavior="placeholder"
        />
        <Flyout open={moreOpen} onOpenChange={setMoreOpen}>
          <FlyoutTrigger asChild><button type="button" aria-label="More workspace pages" className="design-sidebar-item flex w-auto items-center gap-2.5 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4 shrink-0" /><span>More</span></button></FlyoutTrigger>
          <FlyoutContent ref={moreContentRef} tabIndex={-1} onOpenAutoFocus={(event) => { event.preventDefault(); moreContentRef.current?.focus(); }} side={isMobile ? "bottom" : "right"} align="start" className="w-56 p-1" aria-label="More workspace pages">
            {destinations.map(({ label, to, icon: Icon }, index) => <div key={to}>
                {index === 6 || index === 10 ? <div role="separator" className="my-1 border-t border-border" /> : null}
                <div className="group/navigation-pin relative flex items-center rounded-sm transition-colors hover:bg-accent">
                  <Link to={to} onClick={() => { setMoreOpen(false); if (isMobile) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />{label}
                  </Link>
                  <NavigationPinButton pinKey={to} label={label} pins={pinnedNavigation} className="absolute right-0.5 top-1/2 size-8 -translate-y-1/2 rounded-sm opacity-0 transition-opacity group-hover/navigation-pin:opacity-100 group-focus-within/navigation-pin:opacity-100 pointer-coarse:opacity-100" />
                </div>
              </div>)}
          </FlyoutContent>
        </Flyout>
      </div>
      {pinnedNavigation.error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{pinnedNavigation.error}</p>}
      {session.isSuccess && recents.length > 0 && <div className="design-sidebar-recents"><SidebarSection label="Recents" collapsible={{ open: recentsOpen, onOpenChange: setRecentsOpen }}>
        <RecentNavigationList>
        {recents.map(item => item.kind === "task"
          ? <RecentTaskPinRow key={`${scope}:${item.id}`} task={item.task} pins={pinnedNavigation} />
          : item.kind === "chat"
            ? <RecentPinRow key={item.id} pinKey={agentChatPinKey(item.agent.companyId, item.agent.id)} label={item.agent.name} pins={pinnedNavigation}>
                <SidebarNavItem className="design-sidebar-item" to={`/chats/${encodeURIComponent(agentRouteRef(item.agent))}`} label={item.agent.name} iconNode={<AgentAvatar agent={item.agent} size={16} />} />
              </RecentPinRow>
            : <SidebarProjectTasks key={`${scope}:${item.id}`} project={item.project} userId={userId}
                renderTask={task => <RecentTaskPinRow task={task} pins={pinnedNavigation} />}
                renderRow={toggle => <RecentPinRow pinKey={projectPinKey(item.project)} label={item.project.name} pins={pinnedNavigation}>
                  {toggle}
                </RecentPinRow>} />)}
        </RecentNavigationList>
      </SidebarSection></div>}
      {children}
    </nav>
  </aside></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
