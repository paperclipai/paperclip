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
  Settings,
  Activity,
  Sparkles,
} from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarAgents } from "./SidebarAgents";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useLiveUpdates } from "../context/LiveUpdatesProvider";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

const IMPROVEMENT_LABEL_NAMES = new Set(["self-upgrade", "auto-generated"]);

export function Sidebar() {
  const { openNewIssue } = useDialog();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { isConnected: isWsConnected } = useLiveUpdates();
  const { data: sidebarBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
    queryFn: () => sidebarBadgesApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: isWsConnected ? false : 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const improvementCount = useMemo(() => {
    if (!allIssues) return 0;
    return allIssues.filter((issue) => {
      const labels = issue.labels ?? [];
      if (!labels.some((l) => IMPROVEMENT_LABEL_NAMES.has(l.name))) return false;
      return issue.status !== "done" && issue.status !== "cancelled";
    }).length;
  }, [allIssues]);

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="w-60 h-full min-h-0 border-r border-border bg-background flex flex-col">
      {/* Top bar: Company name (bold) + Search — aligned with top sections (no visible border) */}
      <div className="flex items-center gap-1 px-3 h-12 shrink-0">
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

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide flex flex-col gap-4 px-3 py-2">
        <div className="flex flex-col gap-0.5">
          {/* New Issue button aligned with nav items */}
          <button
            onClick={() => openNewIssue()}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem
            to="/inbox"
            label="Inbox"
            icon={Inbox}
            badge={sidebarBadges?.inbox}
            badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
            alert={(sidebarBadges?.failedRuns ?? 0) > 0}
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/improvements" label="Improvements" icon={Sparkles} badge={improvementCount || undefined} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarSection label="Company">
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/costs" label="Costs" icon={DollarSign} />
          <SidebarNavItem to="/activity" label="Activity" icon={History} />
          <SidebarNavItem to="/company/settings" label="Settings" icon={Settings} />
          <SidebarNavItem to="/status" label="System Status" icon={Activity} />
        </SidebarSection>
      </nav>
    </aside>
  );
}
