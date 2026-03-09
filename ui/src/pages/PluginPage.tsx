import { useEffect, useMemo } from "react";
import { Link, Navigate, useParams } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSlotMount } from "@/plugins/slots";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

/**
 * Company-context plugin page. Renders a plugin's `page` slot at
 * `/:companyPrefix/plugins/:pluginId` when the plugin declares a page slot
 * and is enabled for that company.
 *
 * @see doc/plugins/PLUGIN_SPEC.md §19.2 — Company-Context Routes
 * @see doc/plugins/PLUGIN_SPEC.md §24.4 — Company-Context Plugin Page
 */
export function PluginPage() {
  const { companyPrefix: routeCompanyPrefix, pluginId } = useParams<{
    companyPrefix?: string;
    pluginId: string;
  }>();
  const { companies, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const resolvedCompanyId = useMemo(() => {
    if (!routeCompanyPrefix) return selectedCompanyId ?? null;
    const requested = routeCompanyPrefix.toUpperCase();
    return companies.find((c) => c.issuePrefix.toUpperCase() === requested)?.id ?? selectedCompanyId ?? null;
  }, [companies, routeCompanyPrefix, selectedCompanyId]);

  const companyPrefix = useMemo(
    () => (resolvedCompanyId ? companies.find((c) => c.id === resolvedCompanyId)?.issuePrefix ?? null : null),
    [companies, resolvedCompanyId],
  );

  const { data: contributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions(resolvedCompanyId ?? undefined),
    queryFn: () => pluginsApi.listUiContributions(resolvedCompanyId ?? undefined),
    enabled: !!resolvedCompanyId && !!pluginId,
  });

  const pageSlot = useMemo(() => {
    if (!pluginId || !contributions) return null;
    const contribution = contributions.find((c) => c.pluginId === pluginId);
    if (!contribution) return null;
    const slot = contribution.slots.find((s) => s.type === "page");
    if (!slot) return null;
    return {
      ...slot,
      pluginId: contribution.pluginId,
      pluginKey: contribution.pluginKey,
      pluginDisplayName: contribution.displayName,
      pluginVersion: contribution.version,
    };
  }, [pluginId, contributions]);

  const context = useMemo(
    () => ({
      companyId: resolvedCompanyId ?? null,
      companyPrefix,
    }),
    [resolvedCompanyId, companyPrefix],
  );

  useEffect(() => {
    if (pageSlot) {
      setBreadcrumbs([
        { label: "Plugins", href: companyPrefix ? `/${companyPrefix}/settings/plugins` : "/settings/plugins" },
        { label: pageSlot.pluginDisplayName },
      ]);
    }
  }, [pageSlot, companyPrefix, setBreadcrumbs]);

  if (!resolvedCompanyId) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Select a company to view this page.</p>
      </div>
    );
  }

  if (!contributions) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (!pageSlot) {
    // No page slot: redirect to plugin settings where plugin info is always shown
    const settingsPath = companyPrefix ? `/${companyPrefix}/settings/plugins/${pluginId}` : `/settings/plugins/${pluginId}`;
    return <Navigate to={settingsPath} replace />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={companyPrefix ? `/${companyPrefix}/dashboard` : "/dashboard"}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Link>
        </Button>
      </div>
      <PluginSlotMount
        slot={pageSlot}
        context={context}
        className="min-h-[200px]"
        missingBehavior="placeholder"
      />
    </div>
  );
}
