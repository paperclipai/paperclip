import { useEffect, useMemo } from "react";
import { useTranslation } from "@/i18n";
import { useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { NotFoundPage } from "./NotFound";

export function CompanySettingsPluginPage() {
  const params = useParams<{
    companyPrefix?: string;
    settingsRoutePath?: string;
  }>();
  const { t } = useTranslation();
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

  const { slots, isLoading, errorMessage } = usePluginSlots({
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
      {
        label: t("pages.companySettingsPluginPage.breadcrumbSettings", {
          defaultValue: "Settings",
        }),
        href: "/company/settings",
      },
      { label: pageSlot.displayName },
    ]);
  }, [pageSlot, setBreadcrumbs, t]);

  if (!resolvedCompanyId) {
    if (hasInvalidCompanyPrefix) {
      return <NotFoundPage scope="invalid_company_prefix" requestedPrefix={routeCompanyPrefix} />;
    }
    return (
      <div className="text-sm text-muted-foreground">
        {t("pages.companySettingsPluginPage.selectCompany", {
          defaultValue: "Select a company to view this page.",
        })}
      </div>
    );
  }

  if (!settingsRoutePath || isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("pages.companySettingsPluginPage.loading", {
          defaultValue: "Loading...",
        })}
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {t("pages.companySettingsPluginPage.pluginExtensionsUnavailable", {
          message: errorMessage,
          defaultValue: "Plugin extensions unavailable: {{message}}",
        })}
      </div>
    );
  }

  if (pageSlots.length > 1) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        {t("pages.companySettingsPluginPage.multiplePluginsRoutePrefix", {
          defaultValue: "Multiple plugins declare the company settings route",
        })}{" "}
        <code>{settingsRoutePath}</code>.{" "}
        {t("pages.companySettingsPluginPage.multiplePluginsRouteSuffix", {
          defaultValue: "Disable one plugin or change its route.",
        })}
      </div>
    );
  }

  if (!pageSlot) {
    return <NotFoundPage scope="board" />;
  }

  return (
    <PluginSlotMount
      slot={pageSlot}
      context={{ companyId: resolvedCompanyId, companyPrefix }}
      className="min-h-[200px]"
      missingBehavior="placeholder"
    />
  );
}
