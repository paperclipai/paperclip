import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Bell, Boxes, ChevronRight, CircleCheck, FolderOpen, History, LayoutDashboard, MessageCircle, MoreHorizontal, Network, Pin, PinOff, Plus, Repeat, Search, Settings, Unplug } from "lucide-react";
import type { Project } from "@paperclipai/shared";
import { attentionApi } from "@/api/attention";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { usePinnedNavigation } from "@/hooks/usePinnedNavigation";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useLocation } from "@/lib/router";
import { agentRouteRef, cn, projectRouteRef, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { useScrollbarWhileScrolling } from "./side-panel/use-scrollbar-while-scrolling";
import { Flyout, FlyoutContent, FlyoutTrigger, FlyoutAppearanceProvider } from "./ui/flyout";
import { StatusIcon } from "./StatusIcon";

const moreDestinations = [
  { label: "Search", to: "/search", icon: Search },
  { label: "Inbox", to: "/inbox", icon: Inbox },
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", to: "/projects", icon: FolderOpen },
  { label: "Routines", to: "/routines", icon: Repeat },
  { label: "Artifacts", to: "/artifacts", icon: Boxes },
  { label: "Agents", to: "/agents/all", icon: Network },
  { label: "Skills", to: "/skills", icon: Boxes },
  { label: "Connectors", to: "/apps", icon: Unplug },
  { label: "Audit", to: "/activity", icon: History },
  { label: "Settings", to: "/settings", icon: Settings },
] as const;

function ProjectRecent({ project }: { project: Project }) {
  const [expanded, setExpanded] = useState(false);
  const { data: tasks, isPending, error } = useQuery({
    queryKey: [...queryKeys.issues.listByProject(project.companyId, project.id), "coordinator-recents"],
    queryFn: () => issuesApi.list(project.companyId, { projectId: project.id, limit: 12, sortField: "updated", sortDir: "desc" }),
    enabled: expanded,
  });
  return <div>
    <div className="group/coordinator-recent relative">
      <SidebarNavItem to={`/projects/${projectRouteRef(project)}`} label={project.name} icon={FolderOpen} className="design-sidebar-item pr-9" />
      <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded(!expanded)}>
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      </button>
    </div>
    {expanded && <div className="ml-5 border-l border-border pl-1">
      {isPending ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status">Loading tasks…</p> : error ? <p className="px-3 py-2 text-xs text-muted-foreground">Couldn’t load tasks.</p> : tasks?.length ? tasks.map(task =>
        <SidebarNavItem className="design-sidebar-item" key={task.id} to={`/issues/${task.identifier ?? task.id}`} label={task.title} iconNode={<StatusIcon status={task.status} />} />)
        : <p className="px-3 py-2 text-xs text-muted-foreground">No tasks yet.</p>}
    </div>}
  </div>;
}

/** The navigation is a view of the existing records; it never creates a chat
 * or task just because someone visits or switches agents. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const pinnedNavigation = usePinnedNavigation(userId);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreContentRef = useRef<HTMLDivElement>(null);
  const pinnedDestinations = pinnedNavigation.pins.flatMap(to => moreDestinations.filter(item => item.to === to));
  const { entries: recentTasks } = useRecentTasks({ companyId, userId });
  const { collapsed, peeking, isMobile, setSidebarOpen } = useSidebar();
  const rail = collapsed && !peeking;
  const { openNewIssue } = useDialogActions();
  const location = useLocation();
  const handleRecentScroll = useScrollbarWhileScrolling();
  const { data: attention } = useQuery({ queryKey: coordinatorAttentionQueryKey(companyId!), queryFn: () => attentionApi.list(companyId!, { all: true }), enabled: !!companyId });
  const { data: projects } = useQuery({ queryKey: queryKeys.projects.list(companyId!), queryFn: () => projectsApi.list(companyId!), enabled: !!companyId });
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
    return [...taskRows, ...chatRows, ...projectRows].sort((a, b) => b.time - a.time).slice(0, 12);
  }, [agents.data, chats.data, recentTasks, projects, projectVisits, scope]);
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><aside className="coordinator-sidebar design-sidebar w-full">
    <div className="design-sidebar-brand"><SidebarCompanyMenu showChevron={false} /></div>
    <nav className="design-sidebar-navigation" aria-label="Workspace navigation">
      <div className="design-sidebar-primary">
        <SidebarNavItem className="design-sidebar-item" to="/chats" label="Chat" icon={MessageCircle} />
        <div className="group/coordinator-new relative">
          <SidebarNavItem to="/issues" label="Tasks" icon={CircleCheck} className={cn("design-sidebar-item", !rail && "pr-9")} />
          {!rail && <button type="button" aria-label="New task" title="New task" onClick={() => openNewIssue()}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/coordinator-new:opacity-100 group-focus-within/coordinator-new:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" /></button>}
        </div>
        <SidebarNavItem className="design-sidebar-item" to="/decisions" label="Needs You" icon={Bell} badge={attention?.totalCount ?? 0} badgeLabel="decisions" />
        <Flyout open={moreOpen} onOpenChange={setMoreOpen}>
          <FlyoutTrigger asChild><button type="button" aria-label="More workspace pages" className="design-sidebar-item flex w-auto items-center gap-2.5 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4 shrink-0" /><span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : undefined}>More</span></button></FlyoutTrigger>
          <FlyoutContent ref={moreContentRef} tabIndex={-1} onOpenAutoFocus={(event) => { event.preventDefault(); moreContentRef.current?.focus(); }} side={isMobile ? "bottom" : "right"} align="start" className="w-56 p-1" aria-label="More workspace pages">
            {moreDestinations.map(({ label, to, icon: Icon }, index) => {
              const pinned = pinnedNavigation.pins.includes(to);
              const PinIcon = pinned ? PinOff : Pin;
              return <div key={to}>
                {index === 6 || index === 10 ? <div role="separator" className="my-1 border-t border-border" /> : null}
                <div className="group/coordinator-more relative flex items-center rounded-sm transition-colors hover:bg-accent">
                  <Link to={to} onClick={() => { setMoreOpen(false); if (isMobile) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />{label}
                  </Link>
                  <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} ${label}`} aria-pressed={pinned} title={`${pinned ? "Unpin" : "Pin"} ${label}`} disabled={!pinnedNavigation.canPin} onClick={() => pinnedNavigation.toggle(to)} className={cn("absolute right-0.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity outline-none group-hover/coordinator-more:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", pinned ? "text-foreground" : "text-muted-foreground")}>
                    <PinIcon className="size-3.5" />
                  </button>
                </div>
              </div>;
            })}
          </FlyoutContent>
        </Flyout>
      </div>
      {pinnedDestinations.length > 0 && <section className="space-y-1 pt-4" aria-label="Pinned pages">
        {!rail && <div data-slot="sidebar-group-label" className="px-4 pb-1 text-xs text-muted-foreground">Pinned</div>}
        {pinnedDestinations.map(({ label, to, icon }) => <div key={to} className="group/coordinator-pin relative">
          <SidebarNavItem to={to} label={label} icon={icon} className={cn("design-sidebar-item", !rail && "pr-9")} />
          {!rail && <button type="button" aria-label={`Unpin ${label}`} title={`Unpin ${label}`} onClick={() => pinnedNavigation.toggle(to)} className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring group-hover/coordinator-pin:opacity-100 group-focus-within/coordinator-pin:opacity-100 pointer-coarse:opacity-100"><PinOff className="size-3.5" /></button>}
        </div>)}
      </section>}
      {pinnedNavigation.error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{pinnedNavigation.error}</p>}
      {!rail && <div className="design-sidebar-recents"><SidebarSection label="Recents">
        <div className="design-sidebar-recent-list scrollbar-while-scrolling" onScroll={handleRecentScroll} role="region" aria-label="Recents" tabIndex={0}>
        {session.isSuccess && recents.map(item => item.kind === "task"
          ? <SidebarNavItem className="design-sidebar-item" key={item.id} to={`/issues/${item.task.identifier ?? item.id}`} label={item.task.title} iconNode={<StatusIcon status={item.task.status} externalConversationState={item.task.externalConversationState} />} />
          : item.kind === "chat"
            ? <SidebarNavItem className="design-sidebar-item" key={item.id} to={`/chats/${encodeURIComponent(agentRouteRef(item.agent))}`} label={item.agent.name} icon={MessageCircle} />
            : <ProjectRecent key={item.id} project={item.project} />)}
        {session.isSuccess && recents.length === 0 && <p className="px-4 text-xs leading-relaxed text-muted-foreground">Your conversations and tasks will appear here.</p>}
        </div>
      </SidebarSection></div>}
      {children}
    </nav>
  </aside></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
