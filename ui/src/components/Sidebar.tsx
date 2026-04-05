import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Inbox,
  CircleDot,
  Target,
  LayoutDashboard,
  BookOpen,
  BookText,
  BookTemplate,
  DollarSign,
  FileText,
  History,
  Search,
  Shield,
  SquarePen,
  Network,
  Boxes,
  Repeat,
  Settings,
  Hash,
  Package,
  Zap,
  User,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { NavLink } from "@/lib/router";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { heartbeatsApi } from "../api/heartbeats";
import { channelsApi } from "../api/channels";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { cn } from "../lib/utils";

const FEATURE_DOT_KEY = "ironworks.visitedSidebarItems";

function useFeatureDots() {
  const visited = useMemo(() => {
    try {
      const raw = localStorage.getItem(FEATURE_DOT_KEY);
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch {
      return new Set<string>();
    }
  }, []);

  const markVisited = useCallback((path: string) => {
    if (visited.has(path)) return;
    visited.add(path);
    try {
      localStorage.setItem(FEATURE_DOT_KEY, JSON.stringify([...visited]));
    } catch { /* ignore */ }
  }, [visited]);

  const shouldShowDot = useCallback((path: string) => {
    return !visited.has(path);
  }, [visited]);

  return { markVisited, shouldShowDot };
}

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { markVisited, shouldShowDot } = useFeatureDots();
  const inboxBadge = useInboxBadge(selectedCompanyId);
  const [sidebarSearch, setSidebarSearch] = useState("");

  // Track sidebar navigation clicks to dismiss feature dots
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = (e.target as HTMLElement)?.closest?.("a[href]");
      if (target) {
        const href = target.getAttribute("href");
        if (href) markVisited(href);
      }
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [markVisited]);
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const deliverablesReviewCount = sidebarBadges?.deliverablesReview ?? 0;
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  const { data: channels } = useQuery({
    queryKey: queryKeys.channels.list(selectedCompanyId!),
    queryFn: () => channelsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Total unread channel messages
  const totalChannelUnread = useMemo(() => {
    return (channels ?? []).reduce((sum, ch) => sum + (ch.unreadCount ?? 0), 0);
  }, [channels]);

  // Filter helper for sidebar search
  const q = sidebarSearch.toLowerCase().trim();
  const matchLabel = (label: string) => !q || label.toLowerCase().includes(q);

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search */}
      <div className="shrink-0">
        <div className="flex items-center gap-1 px-3 h-12">
          {selectedCompany?.brandColor && (
            <div
              className="w-4 h-4 rounded-sm shrink-0 ml-1"
              style={{ backgroundColor: selectedCompany.brandColor }}
            />
          )}
          <span className="flex-1 text-sm font-bold text-foreground truncate pl-1">
            {selectedCompany?.name ?? "Select company"}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0"
            onClick={openSearch}
          >
            <Search className="h-4 w-4" />
          </Button>
        </div>
        {/* Sidebar filter */}
        <div className="px-3 pb-1">
          <input
            type="text"
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            placeholder="Filter sidebar..."
            className="w-full text-[12px] px-2 py-1 bg-muted/40 border-0 rounded-md text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring/40"
          />
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {matchLabel("War Room") && (
            <SidebarNavItem to="/dashboard" label="War Room" icon={LayoutDashboard} liveCount={liveRunCount} />
          )}
          {matchLabel("Inbox") && (
            <SidebarNavItem
              to="/inbox"
              label="Inbox"
              icon={Inbox}
              badge={inboxBadge.inbox}
              badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
              alert={inboxBadge.failedRuns > 0}
            />
          )}
          {!q && (
            <PluginSlotOutlet
              slotTypes={["sidebar"]}
              context={pluginContext}
              className="flex flex-col gap-0.5"
              itemClassName="text-[13px] font-medium"
              missingBehavior="placeholder"
            />
          )}
        </div>

        <SidebarSection label="Operations">
          {matchLabel("Issues") && <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />}
          {matchLabel("Goals") && <SidebarNavItem to="/goals" label="Goals" icon={Target} />}
          {matchLabel("Routines") && <SidebarNavItem to="/routines" label="Routines" icon={Repeat} />}
          {matchLabel("Playbooks") && <SidebarNavItem to="/playbooks" label="Playbooks" icon={BookTemplate} featureDot={shouldShowDot("/playbooks")} />}
          {matchLabel("Automation") && <SidebarNavItem to="/automation" label="Automation" icon={Zap} />}
          {matchLabel("Board Briefing") && <SidebarNavItem to="/board-briefing" label="Board Briefing" icon={FileText} featureDot={shouldShowDot("/board-briefing")} />}
          {matchLabel("Deliverables") && (
            <SidebarNavItem
              to="/deliverables"
              label="Deliverables"
              icon={Package}
              badge={deliverablesReviewCount}
              badgeTone="default"
            />
          )}
        </SidebarSection>

        {channels && channels.length > 0 && (
          <SidebarSection label="Channels">
            {channels
              .filter((ch) => matchLabel(ch.name))
              .map((channel) => (
              <NavLink
                key={channel.id}
                to={`/channels/${channel.id}`}
                onClick={() => { if (isMobile) setSidebarOpen(false); }}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2.5 px-3 py-2.5 min-h-[36px] text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded-md",
                    isActive
                      ? "bg-accent text-foreground font-semibold"
                      : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <span className="relative shrink-0">
                  <Hash className="h-4 w-4" />
                  {channel.unreadCount != null && channel.unreadCount > 0 && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_2px_hsl(var(--background))]" />
                  )}
                </span>
                <span className="flex-1 truncate">{channel.name}</span>
                {channel.unreadCount != null && channel.unreadCount > 0 && (
                  <span className="ml-auto rounded-full px-1.5 py-0.5 text-xs leading-none bg-primary text-primary-foreground">
                    {channel.unreadCount}
                  </span>
                )}
              </NavLink>
            ))}
          </SidebarSection>
        )}

        {!q && <SidebarProjects />}

        {!q && <SidebarAgents />}

        <SidebarSection label="Company">
          {matchLabel("Org Chart") && <SidebarNavItem to="/org" label="Org Chart" icon={Network} />}
          {matchLabel("Skills") && <SidebarNavItem to="/skills" label="Skills" icon={Boxes} />}
          {matchLabel("Library") && <SidebarNavItem to="/library" label="Library" icon={BookOpen} />}
          {matchLabel("Knowledge Base") && <SidebarNavItem to="/knowledge" label="Knowledge Base" icon={BookText} featureDot={shouldShowDot("/knowledge")} />}
          {matchLabel("Costs") && <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />}
          {matchLabel("Agent Performance") && <SidebarNavItem to="/performance" label="Agent Performance" icon={BarChart3} />}
          {matchLabel("Company Activity") && <SidebarNavItem to="/activity" label="Company Activity" icon={History} />}
          {matchLabel("Audit Log") && <SidebarNavItem to="/audit-log" label="Audit Log" icon={Shield} />}
          {matchLabel("Settings") && <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />}
          {matchLabel("My Profile") && <SidebarNavItem to="/profile" label="My Profile" icon={User} />}
        </SidebarSection>

        {!q && (
          <PluginSlotOutlet
            slotTypes={["sidebarPanel"]}
            context={pluginContext}
            className="flex flex-col gap-3"
            itemClassName="rounded-lg border border-border p-3"
            missingBehavior="placeholder"
          />
        )}
      </nav>
    </aside>
  );
}
