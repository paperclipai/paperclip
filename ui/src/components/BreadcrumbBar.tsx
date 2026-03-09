import { Link, useParams } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment } from "react";

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId } = useCompany();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  if (breadcrumbs.length === 0) return null;

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
      <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center min-w-0 overflow-hidden">
        {menuButton}
        <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
          {breadcrumbs[0].label}
        </h1>
        <div className="ml-auto flex items-center gap-1">
          <PluginLauncherOutlet
            placementZones={["toolbarButton"]}
            context={{
              companyId: selectedCompanyId,
              companyPrefix: companyPrefix ?? null,
            }}
            className="flex items-center gap-1"
          />
          <PluginSlotOutlet
            slotTypes={["toolbarButton"]}
            context={{
              companyId: selectedCompanyId,
              companyPrefix: companyPrefix ?? null,
            }}
            className="flex items-center gap-1"
          />
        </div>
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center min-w-0 overflow-hidden">
      {menuButton}
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
      <div className="ml-auto flex items-center gap-1">
        <PluginLauncherOutlet
          placementZones={["toolbarButton"]}
          context={{
            companyId: selectedCompanyId,
            companyPrefix: companyPrefix ?? null,
          }}
          className="flex items-center gap-1"
        />
        <PluginSlotOutlet
          slotTypes={["toolbarButton"]}
          context={{
            companyId: selectedCompanyId,
            companyPrefix: companyPrefix ?? null,
          }}
          className="flex items-center gap-1"
        />
      </div>
    </div>
  );
}
