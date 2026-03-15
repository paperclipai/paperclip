import { Link } from "@/lib/router";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
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
      <div className="flex h-16 min-w-0 shrink-0 items-center overflow-hidden border-b border-[color:var(--surface-outline)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_8%,transparent),transparent)] px-4 md:px-6">
        {menuButton}
        <div className="min-w-0">
          <div className="paperclip-kicker mb-1">Active Surface</div>
          <h1 className="truncate text-base font-semibold md:text-lg">{breadcrumbs[0].label}</h1>
        </div>
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="flex h-16 min-w-0 shrink-0 items-center overflow-hidden border-b border-[color:var(--surface-outline)] bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_8%,transparent),transparent)] px-4 md:px-6">
      {menuButton}
      <div className="mr-4 hidden md:block">
        <div className="paperclip-kicker">Route Trace</div>
      </div>
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
  );
}
