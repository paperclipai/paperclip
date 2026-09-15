import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useNavigate } from "@/lib/router";
import {
  readContextualSidebarOrigin,
  type ContextualSidebarSurface,
} from "@/lib/shell-navigation";
import { cn } from "@/lib/utils";
import { SidebarNavExpandedProvider } from "./SidebarNavItem";

export function ContextualSidebarFrame({
  surface,
  title,
  icon: Icon,
  fallbackTo = "/dashboard",
  showHeader = true,
  className,
  children,
}: {
  surface: ContextualSidebarSurface;
  title: string;
  icon?: LucideIcon;
  fallbackTo?: string;
  showHeader?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();

  function goBack() {
    navigate(readContextualSidebarOrigin({
      surface,
      companyPrefix: selectedCompany?.issuePrefix,
      fallbackTo,
    }));
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <SidebarNavExpandedProvider>
      <aside
        data-contextual-sidebar={surface}
        className={cn("flex h-full min-h-0 w-full flex-col bg-muted", className)}
      >
        {showHeader ? (
          <div className="flex shrink-0 flex-col gap-1 px-3 py-3">
            <button
              type="button"
              onClick={goBack}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Back from ${title}`}
            >
              <ChevronLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{selectedCompany?.name ?? "Organization"}</span>
            </button>
            <div className="flex min-w-0 items-center gap-2 px-2 py-1">
              {Icon ? <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">{title}</span>
            </div>
          </div>
        ) : null}
        {children}
      </aside>
    </SidebarNavExpandedProvider>
  );
}
