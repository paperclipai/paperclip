import { Link } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useEffect, useRef, useState, useMemo } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { cn } from "../lib/utils";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </div>
  );
}

/**
 * Hook that tracks whether the user has scrolled down enough to collapse the
 * breadcrumb bar on mobile. Uses a scroll listener on the window (since mobile
 * layout uses window scroll). Collapses after 48px of downward scroll, reveals
 * immediately on any upward scroll or when near the top.
 */
function useScrollCollapse() {
  const [collapsed, setCollapsed] = useState(false);
  const lastScrollY = useRef(0);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (y <= 24) {
        setCollapsed(false);
      } else if (y - lastScrollY.current > 4) {
        setCollapsed(true);
      } else if (lastScrollY.current - y > 4) {
        setCollapsed(false);
      }
      lastScrollY.current = y;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return collapsed;
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, isMobile, isNarrow } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const scrollCollapsed = useScrollCollapse();

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbarPlugins context={globalToolbarSlotContext} />;

  // Show the hamburger any time the sidebar is off-canvas (phone + tablet,
  // <lg). isMobile alone would skip tablets and strand users with no way to
  // open the sidebar.
  const menuButton = isNarrow && (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-2 shrink-0"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  );

  if (isMobile && mobileToolbar) {
    return (
      <div
        className={cn(
          "border-b border-border/60 px-2 h-12 shrink-0 flex items-center",
          // Glass-blur sticky bar
          "glass-surface",
          // Collapse on scroll: translate up and fade slightly
          "transition-[transform,opacity] duration-200 ease-out",
          scrollCollapsed ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100",
        )}
      >
        {menuButton}
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div
        className={cn(
          "border-b border-border/60 px-4 md:px-6 h-12 shrink-0 flex items-center",
          isMobile && "glass-surface transition-[transform,opacity] duration-200 ease-out",
          isMobile && scrollCollapsed ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100",
        )}
      >
        {menuButton}
        <div className="ml-auto flex items-center">{globalToolbarSlots}</div>
      </div>
    );
  }

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div
        className={cn(
          "border-b border-border/60 px-4 md:px-6 h-12 shrink-0 flex items-center",
          isMobile && "glass-surface transition-[transform,opacity] duration-200 ease-out",
          isMobile && scrollCollapsed ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100",
        )}
      >
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
            {breadcrumbs[0].label}
          </h1>
        </div>
        {globalToolbarSlots}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div
      className={cn(
        "border-b border-border/60 px-4 md:px-6 h-12 shrink-0 flex items-center",
        isMobile && "glass-surface transition-[transform,opacity] duration-200 ease-out",
        isMobile && scrollCollapsed ? "-translate-y-full opacity-0 pointer-events-none" : "translate-y-0 opacity-100",
      )}
    >
      {menuButton}
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap">
            {breadcrumbs.map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 1;
              return (
                <Fragment key={i}>
                  {i > 0 && <BreadcrumbSeparator />}
                  <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                    {isLast || !crumb.href ? (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      {globalToolbarSlots}
    </div>
  );
}
