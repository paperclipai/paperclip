import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import {
  BellRing,
  CircleDot,
  LayoutDashboard,
  Menu,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
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
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { TopNavItem } from "./TopNavItem";

type GlobalToolbarContext = {
  companyId: string | null;
  companyPrefix: string | null;
};

const TOP_NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/issues", label: "Issues", icon: CircleDot },
  { to: "/agents/all", label: "Agents", icon: Users },
  { to: "/approvals/pending", label: "Approvals", icon: ShieldCheck },
  { to: "/inbox", label: "Inbox", icon: BellRing },
] as const;

const TOP_LEVEL_BREADCRUMB_LABELS = new Set([
  "Dashboard",
  "Inbox",
  "Issues",
  "Agents",
  "Approvals",
]);

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({
    slotTypes: ["globalToolbarButton"],
    companyId: context.companyId,
  });
  const { launchers } = usePluginLaunchers({
    placementZones: ["globalToolbarButton"],
    companyId: context.companyId,
    enabled: !!context.companyId,
  });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      <PluginSlotOutlet
        slotTypes={["globalToolbarButton"]}
        context={context}
        className="flex items-center gap-1"
      />
      <PluginLauncherOutlet
        placementZones={["globalToolbarButton"]}
        context={context}
        className="flex items-center gap-1"
      />
    </div>
  );
}

function openSearch() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [isLgUp, setIsLgUp] = useState(() => window.innerWidth >= 1024);

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = (event: MediaQueryListEvent) => setIsLgUp(event.matches);
    setIsLgUp(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = (
    <GlobalToolbarPlugins context={globalToolbarSlotContext} />
  );

  const searchButton = (
    <Button
      variant="ghost"
      size="sm"
      className="rounded-full border border-border bg-muted/40 px-3 text-muted-foreground hover:bg-muted/60 hover:text-foreground "
      onClick={openSearch}
    >
      <Search className="h-4 w-4" />
      <span className="hidden xl:inline">Search</span>
      <span className="hidden text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80 xl:inline">
        Cmd+K
      </span>
    </Button>
  );

  if (isMobile && mobileToolbar) {
    return (
      <div className="brand-shell flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <div className="min-w-0 flex-1">{mobileToolbar}</div>
        {searchButton}
      </div>
    );
  }

  const menuButton = isMobile ? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="mr-1 shrink-0 rounded-full"
      onClick={toggleSidebar}
      aria-label="Open sidebar"
    >
      <Menu className="h-5 w-5" />
    </Button>
  ) : null;

  const nav = !isMobile ? (
    <div className="hidden lg:flex lg:items-center lg:gap-2">
      {TOP_NAV_ITEMS.map((item) => (
        <TopNavItem key={item.to} {...item} />
      ))}
    </div>
  ) : null;

  const shellRight = (
    <div className="flex items-center gap-2">
      {searchButton}
      {globalToolbarSlots}
    </div>
  );

  const isSingleTopLevelBreadcrumb =
    breadcrumbs.length === 1 &&
    TOP_LEVEL_BREADCRUMB_LABELS.has(breadcrumbs[0]?.label ?? "");

  const showBreadcrumbs = breadcrumbs.length > 0 && !(isLgUp && isSingleTopLevelBreadcrumb);

  return (
    <div className="brand-shell flex h-16 shrink-0 items-center gap-3 border-b border-border/70 px-4 md:px-6">
      {menuButton}
      {nav}
      {showBreadcrumbs ? (
        <>
          <span className="hidden select-none text-muted-foreground lg:inline">|</span>
          <div className="min-w-0 flex-1 overflow-hidden">
            <Breadcrumb className="min-w-0 overflow-hidden">
              <BreadcrumbList className="flex-nowrap">
                {breadcrumbs.map((crumb, i) => {
                  const isLast = i === breadcrumbs.length - 1;
                  return (
                    <Fragment key={i}>
                      {i > 0 && <BreadcrumbSeparator />}
                      <BreadcrumbItem className={isLast ? "min-w-0" : "shrink-0"}>
                        {isLast || !crumb.href ? (
                          <BreadcrumbPage className="truncate">
                            {crumb.label}
                          </BreadcrumbPage>
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
        </>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      {shellRight}
    </div>
  );
}
