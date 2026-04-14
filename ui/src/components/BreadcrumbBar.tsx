import { Link } from "@/lib/router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Menu } from "lucide-react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { useToast } from "../context/ToastContext";
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
import { CompanyRuntimeButton } from "./CompanyRuntimeButton";

type GlobalToolbarContext = { companyId: string | null; companyPrefix: string | null };

function GlobalToolbarPlugins({ context }: { context: GlobalToolbarContext }) {
  const { slots } = usePluginSlots({ slotTypes: ["globalToolbarButton"], companyId: context.companyId });
  const { launchers } = usePluginLaunchers({ placementZones: ["globalToolbarButton"], companyId: context.companyId, enabled: !!context.companyId });
  if (slots.length === 0 && launchers.length === 0) return null;
  return (
    <>
      <PluginSlotOutlet slotTypes={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
      <PluginLauncherOutlet placementZones={["globalToolbarButton"]} context={context} className="flex items-center gap-1" />
    </>
  );
}

export function BreadcrumbBar() {
  const { breadcrumbs } = useBreadcrumbs();
  const { toggleSidebar, isMobile } = useSidebar();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const lifecycleMutation = useMutation({
    mutationFn: ({ action, companyId }: { action: "pause" | "resume"; companyId: string }) =>
      action === "pause"
        ? companiesApi.pause(companyId)
        : companiesApi.resume(companyId),
    onSuccess: async (_company, { action, companyId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({ queryKey: ["heartbeats", companyId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.org(companyId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(companyId) }),
      ]);

      pushToast({
        title: action === "pause" ? "Company paused" : "Company resumed",
        body:
          action === "pause"
            ? "New runs are paused at the company level."
            : "Company-level execution resumed.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update company runtime",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const globalToolbarSlotContext = useMemo(
    () => ({
      companyId: selectedCompanyId ?? null,
      companyPrefix: selectedCompany?.issuePrefix ?? null,
    }),
    [selectedCompanyId, selectedCompany?.issuePrefix],
  );

  const globalToolbarSlots = <GlobalToolbarPlugins context={globalToolbarSlotContext} />;
  const showRuntimeButton = Boolean(selectedCompanyId && selectedCompany && selectedCompany.status !== "archived");

  const runtimeButton = showRuntimeButton ? (
    <CompanyRuntimeButton
      companyPaused={selectedCompany?.status === "paused"}
      pauseReason={selectedCompany?.pauseReason ?? null}
      isPending={lifecycleMutation.isPending}
      pendingAction={lifecycleMutation.variables?.action}
      onPause={() => {
        if (!selectedCompanyId || !selectedCompany) return;
        lifecycleMutation.mutate({ action: "pause", companyId: selectedCompanyId });
      }}
      onResume={() => {
        if (!selectedCompanyId || !selectedCompany) return;
        lifecycleMutation.mutate({ action: "resume", companyId: selectedCompanyId });
      }}
    />
  ) : null;

  const rightControls = (runtimeButton || globalToolbarSlots) ? (
    <div className="flex items-center gap-1 ml-auto shrink-0 pl-2">
      {runtimeButton}
      {globalToolbarSlots}
    </div>
  ) : null;

  const desktopCenterBrand = (
    <div className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 md:block">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Orchestrero
      </span>
    </div>
  );

  if (breadcrumbs.length === 0) {
    return (
      <div className="relative border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center justify-end">
        {desktopCenterBrand}
        {rightControls}
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
      <div className="relative border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
        {desktopCenterBrand}
        {menuButton}
        <div className="min-w-0 overflow-hidden flex-1">
          <h1 className="text-sm font-semibold uppercase tracking-wider truncate">
            {breadcrumbs[0].label}
          </h1>
        </div>
        {rightControls}
      </div>
    );
  }

  // Multiple breadcrumbs = breadcrumb trail
  return (
    <div className="relative border-b border-border px-4 md:px-6 h-12 shrink-0 flex items-center">
      {desktopCenterBrand}
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
      {rightControls}
    </div>
  );
}
