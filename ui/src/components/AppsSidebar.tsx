import { ChevronLeft, AppWindow, Store, ShieldQuestion } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { DEVELOPER_TABS, advancedTabHref, isExperimentalToolTab } from "@/pages/tools/tool-tabs";
import { useSmokeLabEnabled } from "@/hooks/useSmokeLabEnabled";
import { useReviewCount } from "@/pages/apps/useReviewCount";
import { SidebarNavItem } from "./SidebarNavItem";

/**
 * Secondary sidebar for the prosumer Apps area (PAP-10856; three-door IA
 * PAP-13254 / U3).
 *
 *   ← Back · APPS: Browse / Connections / Review (n)
 *   DEVELOPER: Gateways / Profiles / Rules / Health / Activity
 *
 * The three consumer doors are peers: "Browse" (the store — discover + add),
 * "Connections" (your connected tools + health), and "Review" (PAP-12371,
 * Finding B — decisions waiting on your OK, with a live pending count).
 * "Needs attention" is no longer a door: health/error triage folds into
 * Connections as a status filter + banner, so approvals are never buried
 * behind an error label. The Developer section was folded in from the retired
 * ToolsSidebar (PAP-10915) so the whole Apps area shares one sidebar; a
 * one-line caption frames who it's for (Finding A). "Run your own" and "Paste a
 * config" moved out of the sidebar into rows on the Connect-an-app page
 * (PAP-10922).
 */
export function AppsSidebar() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

  const reviewCount = useReviewCount();
  const { enabled: smokeLabEnabled } = useSmokeLabEnabled();
  const developerTabs = DEVELOPER_TABS.filter(
    (tab) => !isExperimentalToolTab(tab.key) || smokeLabEnabled,
  );

  const runtimeSlots = useQuery({
    queryKey: queryKeys.tools.runtimeSlots(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listRuntimeSlots(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  const runtimeActiveCount = (runtimeSlots.data?.runtimeSlots ?? [])
    .filter((slot) => slot.status === "running").length;

  return (
    <aside className="w-full h-full min-h-0 border-r border-border bg-background flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-3 shrink-0">
        <Link
          to="/dashboard"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? "Company"}</span>
        </Link>
        <div className="flex items-center gap-2 px-2 py-1">
          <AppWindow className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-bold text-foreground">Apps</span>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="px-3 pb-1 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Apps
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/apps/browse" label="Browse" icon={Store} />
          <SidebarNavItem to="/apps" label="Connections" icon={AppWindow} end />
          <SidebarNavItem
            to="/apps/review"
            label="Review"
            icon={ShieldQuestion}
            badge={reviewCount > 0 ? reviewCount : undefined}
            badgeTone="warning"
            badgeLabel="waiting for your OK"
          />
        </div>
        <div className="px-3 pb-1 pt-4 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
          Developer
        </div>
        <p className="px-3 pb-1.5 text-(length:--text-micro) leading-snug text-muted-foreground/70">
          Advanced setup for developers. Most teams never open this.
        </p>
        <div className="flex flex-col gap-0.5">
          {developerTabs.map((tab) => (
            <SidebarNavItem
              key={tab.key}
              to={advancedTabHref(tab.key)}
              label={tab.label}
              icon={tab.icon}
              end
              liveCount={tab.key === "runtime" && runtimeActiveCount > 0 ? runtimeActiveCount : undefined}
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}
