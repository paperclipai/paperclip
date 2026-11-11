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
import { useTx } from "@/i18n/tx";
import { useCoordinatorPresentation } from "./coordinator/CoordinatorPresentation";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

const MAX_TASK_TITLE_CHARACTERS = 48;
function taskTitleLabel(title: string) {
  const characters = Array.from(title);
  return characters.length > MAX_TASK_TITLE_CHARACTERS
    ? `${characters.slice(0, MAX_TASK_TITLE_CHARACTERS - 1).join("")}…`
    : title;
}

/** Task identifier rendered in gray monospace beside its breadcrumb label. */
function CrumbIdentifier({ identifier }: { identifier?: string }) {
  if (!identifier) return null;
  return (
    <span data-slot="task-title-identifier" className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
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

export function BreadcrumbBar({ taskDetailLayout = false, showPropertiesToggle = taskDetailLayout }: { taskDetailLayout?: boolean; showPropertiesToggle?: boolean }) {
  const coordinatorEnabled = useCoordinatorPresentation();
  const {
    breadcrumbs,
    breadcrumbToolbar,
    breadcrumbPanelControl,
    mobileToolbar,
  } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { panelVisible, togglePanelVisible } = usePanel();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const tx = useTx();
  const taskPanelOpen = breadcrumbPanelControl?.open ?? panelVisible;
  const toggleTaskPanel = breadcrumbPanelControl?.onToggle ?? togglePanelVisible;
  const propertiesToggle = showPropertiesToggle ? (
    <Button
      variant="ghost"
      size="icon-sm"
      className="ml-5 size-9 shrink-0 text-muted-foreground"
      onClick={toggleTaskPanel}
      aria-label={taskPanelOpen ? tx("Hide properties") : tx("Show properties")}
      title={taskPanelOpen ? tx("Hide properties") : tx("Show properties")}
    >
      {taskPanelOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
    </Button>
  ) : null;

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
      aria-label={tx("Open sidebar")}
    >
      <Menu className="h-5 w-5" />
    </Button>
  );

  const currentCrumb = breadcrumbs[breadcrumbs.length - 1];
  const isTaskTrail = Boolean(currentCrumb.identifier);
  const visibleBreadcrumbs = isMobile && isTaskTrail && breadcrumbs.length > 1 ? breadcrumbs.slice(1) : breadcrumbs;
  if (isMobile && isTaskTrail && visibleBreadcrumbs.length === 1) {
    return (
      <div className="h-(--sz-60px) shrink-0 flex items-center border-b border-border px-4">
        {menuButton}
        <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
          {currentCrumb.leading ? (
            <span className="flex shrink-0 items-center self-center">{currentCrumb.leading}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate" title={tx(currentCrumb.label)} aria-label={tx(currentCrumb.label)}>{tx(taskTitleLabel(currentCrumb.label))}</span>
          <CrumbIdentifier identifier={currentCrumb.identifier} />
        </h1>
        {globalToolbarSlots}
      </div>
    );
  }

  const breadcrumbTrail = (
    <div className="min-w-0 overflow-hidden flex-1">
      <Breadcrumb className="min-w-0 overflow-hidden">
        <BreadcrumbList className="flex-nowrap">
          {visibleBreadcrumbs.map((crumb, i) => {
            const isLast = i === visibleBreadcrumbs.length - 1;
            const isTask = isTaskTrail && (isMobile || i > 0 || visibleBreadcrumbs.length === 1);
            const pinnedIdentifier = (taskDetailLayout || isMobile) && isLast && Boolean(crumb.identifier);
            const label = tx(isTask ? taskTitleLabel(crumb.label) : crumb.label);
            const accessibleLabel = [tx(crumb.label), crumb.identifier].filter(Boolean).join(" ");
            return (
              <Fragment key={i}>
                {i > 0 && <BreadcrumbSeparator />}
                <BreadcrumbItem className={cn(isLast || isTask ? "min-w-0" : "shrink-0", isTask && !isLast && "max-w-(--breadcrumb-parent-max-width)", pinnedIdentifier && "flex-1")}>
                  {crumb.control ?? (isLast || !crumb.href ? (
                    crumb.leading || crumb.identifier ? (
                      <BreadcrumbPage aria-current={isLast ? "page" : undefined} aria-label={accessibleLabel} className={cn("flex min-w-0 gap-1.5", crumb.trailing ? "items-center" : "items-baseline", (isTask || pinnedIdentifier) && "flex-1")}>
                        {crumb.leading && (
                          <span className="flex shrink-0 items-center self-center">{crumb.leading}</span>
                        )}
                        {!taskDetailLayout && !isMobile ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                        <span title={tx(crumb.label)} className={cn("min-w-0 truncate", pinnedIdentifier && "flex-1")}>{label}</span>
                        {(taskDetailLayout || isMobile) && isLast ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbPage aria-current={isLast ? "page" : undefined} aria-label={accessibleLabel} title={tx(crumb.label)} className="truncate">{label}</BreadcrumbPage>
                    )
                  ) : (
                    <BreadcrumbLink asChild>
                      {crumb.leading || crumb.identifier ? (
                        <Link
                          to={crumb.href} onClick={crumb.onClick}
                          title={tx(crumb.label)} aria-label={accessibleLabel}
                          className={cn(
                            "flex min-w-0 items-baseline gap-1.5",
                            isTask && "flex-1",
                            i === 0 && !isTask && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {crumb.leading && (
                            <span className="flex shrink-0 items-center self-center">{crumb.leading}</span>
                          )}
                          {!isMobile ? <CrumbIdentifier identifier={crumb.identifier} /> : null}
                          <span className="min-w-0 truncate">{label}</span>
                        </Link>
                      ) : (
                        <Link
                          to={crumb.href} onClick={crumb.onClick}
                          title={tx(crumb.label)} aria-label={accessibleLabel}
                          className={cn(
                            "min-w-0 truncate",
                            i === 0 && !isTask && "font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {label}
                        </Link>
                      )}
                    </BreadcrumbLink>
                  ))}
                  {!crumb.control && crumb.trailing && <span className="flex shrink-0 items-center">{crumb.trailing}</span>}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );

  // Task details use the same breadcrumb typography even with one item.
  // Other single-crumb pages keep their existing page-title presentation.
  if (breadcrumbs.length === 1 && !taskDetailLayout) {
    return (
      <div className="h-(--sz-60px) shrink-0 flex items-center border-b border-border px-4 md:px-6">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {breadcrumbs[0].control ? (
            <h1 className="min-w-0 text-sm font-semibold uppercase tracking-wider">{breadcrumbs[0].control}</h1>
          ) : breadcrumbs[0].leading || breadcrumbs[0].identifier ? (
            <h1 className="flex items-baseline gap-1.5 text-sm font-semibold uppercase tracking-wider">
              {breadcrumbs[0].leading && (
                <span className="flex shrink-0 items-center self-center">{breadcrumbs[0].leading}</span>
              )}
              <CrumbIdentifier identifier={breadcrumbs[0].identifier} />
              <span className="truncate" title={breadcrumbs[0].label}>{isTaskTrail ? taskTitleLabel(breadcrumbs[0].label) : breadcrumbs[0].label}</span>
            </h1>
          ) : (
            <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
              {breadcrumbs[0].label}
            </h1>
          )}
        </div>
        {coordinatorEnabled && !breadcrumbs[0].control && breadcrumbs[0].trailing ? (
          <span className="ml-2 flex shrink-0 items-center">{breadcrumbs[0].trailing}</span>
        ) : null}
        {globalToolbarSlots}
        {propertiesToggle}
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
      {isMobile && isTaskTrail ? null : propertiesToggle}
    </div>
  );
}
