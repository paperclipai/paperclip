import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useSidebar } from "@/context/SidebarContext";
import { useCompany } from "@/context/CompanyContext";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const SECTION_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/agents": "Agents",
  "/projects": "Projects",
  "/issues": "Issues",
  "/workflows": "Workflows",
  "/goals": "Goals",
  "/settings": "Settings",
  "/approvals": "Settings",
  "/org-chart": "Settings",
};

function getSectionTitle(pathname: string): string {
  for (const [prefix, title] of Object.entries(SECTION_TITLES)) {
    if (pathname.startsWith(prefix)) return title;
  }
  return "ArchonOS";
}

export function Sidebar() {
  const { sidebarOpen, toggleSidebar } = useSidebar();
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const location = useLocation();
  const sectionTitle = getSectionTitle(location.pathname);
  const isDashboard = location.pathname.startsWith("/dashboard");
  const title = isDashboard && selectedCompany ? selectedCompany.name : sectionTitle;

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r transition-[width]",
        sidebarOpen ? "w-[var(--sidebar-w)]" : "w-0",
      )}
      style={{
        background: "var(--sidebar-bg)",
        borderColor: "var(--border-subtle)",
        transitionDuration: "var(--duration-normal)",
        transitionTimingFunction: "var(--ease-spring)",
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        {companies.length > 1 ? (
          <select
            value={selectedCompany?.id ?? ""}
            onChange={(e) => setSelectedCompanyId(e.target.value)}
            className="text-[11px] font-semibold uppercase tracking-[0.08em] bg-transparent outline-none cursor-pointer"
            style={{ color: "var(--fg-muted)", border: "none", padding: 0 }}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        ) : (
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: "var(--fg-muted)" }}
          >
            {selectedCompany?.name ?? title}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2">
        <SidebarNav pathname={location.pathname} />
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between border-t px-4 py-3"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span className="text-[11px]" style={{ color: "var(--fg-muted)" }}>
          v0.1.0
        </span>
        <button
          onClick={toggleSidebar}
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors"
          style={{ color: "var(--fg-muted)" }}
          title="Toggle sidebar (⌘B)"
          aria-label="Toggle sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      </div>
    </aside>
  );
}

function SidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const navTo = (path: string) => () => navigate(path);
  const isAt = (path: string) => pathname === path || pathname.startsWith(path + "/");

  if (pathname.startsWith("/settings") || pathname.startsWith("/plugins") || pathname.startsWith("/local-ai") || pathname.startsWith("/automation") || pathname.startsWith("/approvals") || pathname.startsWith("/org-chart")) {
    return (
      <>
        <div className="text-[11px] font-medium px-2 py-2 tracking-wide" style={{ color: "var(--fg-muted)" }}>Settings</div>
        <SidebarItem label="Appearance" active={isAt("/settings")} onClick={navTo("/settings")} />
        <SidebarItem label="Plugins" active={isAt("/plugins")} onClick={navTo("/plugins")} />
        <SidebarItem label="Local AI" active={isAt("/local-ai")} onClick={navTo("/local-ai")} />
        <SidebarItem label="Automation" active={isAt("/automation")} onClick={navTo("/automation")} />
        <SidebarItem label="Approvals" active={isAt("/approvals")} onClick={navTo("/approvals")} />
        <SidebarItem label="Org Chart" active={isAt("/org-chart")} onClick={navTo("/org-chart")} />
        <SidebarItem label="Costs" active={isAt("/costs")} onClick={navTo("/costs")} />
      </>
    );
  }

  if (pathname.startsWith("/agents")) {
    return (
      <>
        <div className="text-[11px] font-medium px-2 py-2 tracking-wide" style={{ color: "var(--fg-muted)" }}>Agents</div>
        <SidebarItem label="All Agents" active={isAt("/agents")} onClick={navTo("/agents")} badge={agents.length > 0 ? String(agents.length) : undefined} />
      </>
    );
  }

  if (pathname.startsWith("/issues")) {
    return (
      <>
        <div className="text-[11px] font-medium px-2 py-2 tracking-wide" style={{ color: "var(--fg-muted)" }}>Issues</div>
        <SidebarItem label="All Issues" active={isAt("/issues")} onClick={navTo("/issues")} />
      </>
    );
  }

  if (pathname.startsWith("/costs")) {
    return (
      <>
        <div className="text-[11px] font-medium px-2 py-2 tracking-wide" style={{ color: "var(--fg-muted)" }}>Finance</div>
        <SidebarItem label="Costs" active={isAt("/costs")} onClick={navTo("/costs")} />
      </>
    );
  }

  return (
    <>
      <div className="text-[11px] font-medium px-2 py-2 tracking-wide" style={{ color: "var(--fg-muted)" }}>Navigation</div>
      <SidebarItem label="Overview" active={isAt("/dashboard")} onClick={navTo("/dashboard")} />
      <SidebarItem label="Activity" onClick={navTo("/activity")} active={isAt("/activity")} />
      <SidebarItem label="Costs" onClick={navTo("/costs")} />
    </>
  );
}

function SidebarItem({ label, badge, active, onClick }: { label: string; badge?: string; active?: boolean; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] transition-colors",
        active
          ? "font-medium"
          : "hover:bg-[var(--bg-muted)]",
      )}
      style={{
        color: active ? "var(--accent)" : "var(--fg-secondary)",
        background: active ? "var(--accent-subtle)" : undefined,
      }}
    >
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span
          className="rounded-full px-1.5 text-[11px] font-medium"
          style={{
            background: active ? "var(--accent)" : "var(--bg-muted)",
            color: active ? "var(--accent-fg)" : "var(--fg-muted)",
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}
