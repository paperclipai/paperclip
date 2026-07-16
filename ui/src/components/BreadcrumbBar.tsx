import { Link } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs, type Breadcrumb as BreadcrumbType } from "../context/BreadcrumbContext";
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
import { Fragment, useMemo } from "react";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { PluginLauncherOutlet, usePluginLaunchers } from "@/plugins/launchers";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

/**
 * Renders a crumb's label, optionally prefixed with a muted `labelPrefix` (e.g.
 * a task identifier) inside the same crumb — reads as "<id> <title>", not a
 * separate hierarchical item. The prefix stays fixed-width; only the title
 * truncates.
 */
function renderCrumbLabel(crumb: BreadcrumbType) {
  if (!crumb.labelPrefix) {
    return <span className="truncate">{crumb.label}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-muted-foreground">{crumb.labelPrefix}</span>
      <span className="truncate">{crumb.label}</span>
    </span>
  );
}

function GlobalToolbar({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2 empty:hidden">
      {slots.length > 0 ? (
        <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
      {launchers.length > 0 ? (
        <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      ) : null}
    </div>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs, mobileToolbar } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbar context={globalToolbarSlotContext} />;

  if (isMobile && mobileToolbar) {
    return (
      <div className="border-b border-border px-2 h-12 shrink-0 flex items-center">
        {mobileToolbar}
      </div>
    );
  }

  if (breadcrumbs.length === 0) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center justify-end">
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

  // Single breadcrumb = page title (uppercase)
  if (breadcrumbs.length === 1) {
    return (
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          {breadcrumbs[0].leading ? (
            <h1 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider">
              <span className="flex shrink-0 items-center">{breadcrumbs[0].leading}</span>
              {renderCrumbLabel(breadcrumbs[0])}
            </h1>
          ) : (
            <h1 className="flex min-w-0 items-center text-sm font-semibold uppercase tracking-wider">
              {renderCrumbLabel(breadcrumbs[0])}
            </h1>
          )}
        </div>
        {globalToolbarSlots}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
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
                      crumb.leading ? (
                        <BreadcrumbPage className="flex min-w-0 items-center gap-1.5">
                          <span className="flex shrink-0 items-center">{crumb.leading}</span>
                          {renderCrumbLabel(crumb)}
                        </BreadcrumbPage>
                      ) : (
                        <BreadcrumbPage className="min-w-0">{renderCrumbLabel(crumb)}</BreadcrumbPage>
                      )
                    ) : (
                      <BreadcrumbLink asChild>
                        {crumb.leading ? (
                          <Link to={crumb.href} className="flex items-center gap-1.5">
                            <span className="flex shrink-0 items-center">{crumb.leading}</span>
                            <span className="truncate">{crumb.label}</span>
                          </Link>
                        ) : (
                          <Link to={crumb.href}>{crumb.label}</Link>
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
      {globalToolbarSlots}
    </div>
  );
}
