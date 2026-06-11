import { ChevronLeft, AppWindow, Settings2, ShieldAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { SidebarNavItem } from "./SidebarNavItem";

/**
 * Secondary sidebar for the prosumer Apps area (PAP-10856, v1.1).
 *
 *   ← Back · APPS: All apps / Needs attention (n) / Advanced setup [Admin]
 *
 * "Needs attention" is its own page in P3; until then we render the entry as a
 * disabled placeholder with no count. "Advanced setup" links to the existing
 * Tools surface (the developer door); its dedicated mount + `/tools/:tab`
 * redirect ship in P5.
 */
export function AppsSidebar() {
  const { selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

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
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Apps
        </div>
        <div className="flex flex-col gap-0.5">
          <SidebarNavItem to="/apps" label="All apps" icon={AppWindow} end />
          {/* Needs attention page lands in P3 — show the entry, no count yet. */}
          <div
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-foreground/40"
            aria-disabled="true"
            title="Coming soon"
          >
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">Needs attention</span>
          </div>
          <SidebarNavItem
            to="/tools"
            label="Advanced setup"
            icon={Settings2}
            textBadge="Admin"
          />
        </div>
      </nav>
    </aside>
  );
}
