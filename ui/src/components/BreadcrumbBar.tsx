import { Link } from "@/lib/router";
import { Menu, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment, useMemo, type ReactNode } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";
import { cn } from "../lib/utils";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

/** Task identifier rendered in gray monospace beside its breadcrumb label. */
function CrumbIdentifier({ identifier }: { identifier?: string }) {
  if (!identifier) return null;
  return (
    <span data-slot="task-title-identifier" className="shrink-0 font-mono text-muted-foreground">
      {identifier}
    </span>
  );
}

function GlobalToolbar({
  context,
  pageToolbar,
}: {
  context: GlobalToolbarContext;
  pageToolbar?: ReactNode;
}) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2 empty:hidden">
      {pageToolbar}
      {slots.length > 0 ? (
        <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
      {launchers.length > 0 ? (
        <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
    </div>
  );
}

export function BreadcrumbBar({ taskDetailLayout = false }: { taskDetailLayout?: boolean }) {
  const {
    breadcrumbs,
    breadcrumbToolbar,
    breadcrumbPanelControl,
    mobileToolbar,
  } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { panelVisible, togglePanelVisible } = usePanel();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const taskPanelOpen = breadcrumbPanelControl?.open ?? panelVisible;
  const toggleTaskPanel = breadcrumbPanelControl?.onToggle ?? togglePanelVisible;

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = (
    <GlobalToolbar
      context={globalToolbarSlotContext}
      pageToolbar={isMobile ? null : breadcrumbToolbar}
    />
  );

  if (isMobile && mobileToolbar) {
    return (
      <div className="h-(--sz-60px) shrink-0 flex items-center border-b border-border px-2">
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div className="h-(--sz-60px) shrink-0 flex items-center justify-end border-b border-border px-4 md:px-6">
        {globalToolbarSlots}
      </div>
    );
  }

  const menuButton = isMobile && (
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

  const breadcrumbTrail = (
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
                    crumb.leading || crumb.identifier ? (
                      <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
                        {crumb.leading && (
                          <span className="flex shrink-0 items-center">{crumb.leading}</span>
                        )}
                        {!taskDetailLayout ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                        <span className="min-w-0 truncate">{crumb.label}</span>
                        {taskDetailLayout && isLast ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    )
                  ) : (
                    <BreadcrumbLink asChild>
                      {crumb.leading || crumb.identifier ? (
                        <Link
                          to={crumb.href}
                          className={cn(
                            "flex min-w-0 items-center gap-1.5",
                            i === 0 && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {crumb.leading && (
                            <span className="flex shrink-0 items-center">{crumb.leading}</span>
                          )}
                          {!taskDetailLayout ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                          <span className="min-w-0 truncate">{crumb.label}</span>
                          {taskDetailLayout && isLast ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                        </Link>
                      ) : (
                        <Link
                          to={crumb.href}
                          className={cn(
                            "min-w-0 truncate",
                            i === 0 && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {crumb.label}
                        </Link>
                      )}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className="h-(--sz-60px) shrink-0 flex items-center border-b border-border px-4 md:px-6">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {breadcrumbs[0].leading || breadcrumbs[0].identifier ? (
            <h1 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider">
              {breadcrumbs[0].leading && (
                <span className="flex shrink-0 items-center">{breadcrumbs[0].leading}</span>
              )}
              <CrumbIdentifier identifier={breadcrumbs[0].identifier} />
              <span className="truncate">{breadcrumbs[0].label}</span>
            </h1>
          ) : (
            <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
              {breadcrumbs[0].label}
            </h1>
          )}
        </div>
        {globalToolbarSlots}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div
      className={cn(
        "relative h-(--sz-60px) shrink-0 flex items-center border-b border-border",
        "px-4 md:px-6",
      )}
    >
      {menuButton}
      {breadcrumbTrail}
      {globalToolbarSlots}
      {taskDetailLayout ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-5 size-9 shrink-0 text-muted-foreground"
          onClick={toggleTaskPanel}
          aria-label={taskPanelOpen ? "Hide properties" : "Show properties"}
          title={taskPanelOpen ? "Hide properties" : "Show properties"}
        >
          {taskPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
        </Button>
      ) : null}
    </div>
  );
}
