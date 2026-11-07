import { useTranslation } from "@/i18n";
import { useEffect, useMemo } from "react";
import { useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { QueryErrorState } from "@/components/QueryView";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { NotFoundPage } from "./NotFound";

export function CompanySettingsPluginPage() {
  const { t: translateAgentPage } = useTranslation("agents");
  const params = useParams<{
    companyPrefix?: string;
    settingsRoutePath?: string;
  }>();
  const { companyPrefix: routeCompanyPrefix, settingsRoutePath } = params;
  const { companies, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const routeCompany = useMemo(() => {
    if (!routeCompanyPrefix) return null;
    const requested = routeCompanyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requested) ?? null;
  }, [companies, routeCompanyPrefix]);
  const hasInvalidCompanyPrefix = Boolean(routeCompanyPrefix) && !routeCompany;
  const resolvedCompanyId = routeCompany?.id ?? (routeCompanyPrefix ? null : selectedCompanyId ?? null);
  const companyPrefix = resolvedCompanyId
    ? companies.find((company) => company.id === resolvedCompanyId)?.issuePrefix ?? null
    : null;

  const { slots, isLoading, errorMessage, error, retry } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: resolvedCompanyId,
    enabled: Boolean(resolvedCompanyId && settingsRoutePath),
  });

  const pageSlots = useMemo(() => {
    if (!settingsRoutePath) return [];
    return slots.filter((slot) => slot.routePath === settingsRoutePath);
  }, [settingsRoutePath, slots]);

  const pageSlot = pageSlots.length === 1 ? pageSlots[0] : null;

  useEffect(() => {
    if (!pageSlot) return;
    setBreadcrumbs([
      { label: translateAgentPage("agents:settings"), href: "/company/settings" },
      { label: pageSlot.displayName },
    ]);
  }, [pageSlot, setBreadcrumbs, translateAgentPage]);

  if (!resolvedCompanyId) {
    if (hasInvalidCompanyPrefix) {
      return <NotFoundPage scope="invalid_company_prefix" requestedPrefix={routeCompanyPrefix} />;
    }
    return <div className="text-sm text-muted-foreground">{translateAgentPage("agents:select_an_organization_to_view_this_page")}</div>;
  }

  if (!settingsRoutePath || isLoading) {
    return <div className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_b04ba4")}</div>;
  }

  // Only a real failure reaches here; an outage keeps `isLoading` true above.
  if (errorMessage) {
    return <QueryErrorState error={error} action={translateAgentPage("agents:load_plugin_extensions")} onRetry={retry} className="max-w-xl" />;
  }

  if (pageSlots.length > 1) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{translateAgentPage("agents:multiple_plugins_declare_the_company_settings_route")}{" "}<code>{settingsRoutePath}</code>{translateAgentPage("agents:disable_one_plugin_or_change_its_route")}</div>
    );
  }

  if (!pageSlot) {
    return <NotFoundPage scope="board" />;
  }

  return (
    <div className="max-w-6xl">
      <PluginSlotMount
        slot={pageSlot}
        context={{ companyId: resolvedCompanyId, companyPrefix }}
        className="min-h-(--sz-200px)"
        missingBehavior="placeholder"
      />
    </div>
  );
}
