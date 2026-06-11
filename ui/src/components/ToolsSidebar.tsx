import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Settings2 } from "lucide-react";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { TOOL_TABS, advancedTabHref } from "@/pages/tools/tool-tabs";
import { SidebarNavItem } from "./SidebarNavItem";

export function ToolsSidebar() {
  const { selectedCompanyId } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
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
          to="/apps"
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Apps</span>
        </Link>
        <div className="flex items-center gap-2 px-2 py-1">
          <Settings2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="flex-1 truncate text-sm font-bold text-foreground">
            Advanced setup
          </span>
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto scrollbar-auto-hide px-3 py-2">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Advanced setup
        </div>
        <div className="flex flex-col gap-0.5">
          {TOOL_TABS.map((tab) => (
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
