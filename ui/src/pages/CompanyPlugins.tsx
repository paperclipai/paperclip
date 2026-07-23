import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Puzzle, Settings as SettingsIcon } from "lucide-react";
import { ApiError } from "@/api/client";
import { pluginsApi, type CompanyPluginCatalogItem } from "@/api/plugins";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { Link, Navigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

/**
 * Company-settings "Plugins" page (settings surface `company.plugins`).
 *
 * Lists every `ready`, catalog-eligible plugin with its per-company
 * enablement state and lets holders of `plugins:manage` (company
 * owners/admins implicitly) turn plugins on or off for this company.
 * Plugins are installed/removed by instance admins (see PluginManager);
 * this page only toggles the company-scoped switch.
 *
 * Locked plugins (`manifest.companyEnablement.locked`) render as
 * non-interactive "Managed by instance" rows.
 *
 * A 403 from the catalog (hidden surface, revoked access) is a navigation
 * miss, not a crash: redirect to the company settings root.
 *
 * @see server/src/routes/plugins.ts — `GET /plugins/companies/:companyId/catalog`
 *   and `PUT /plugins/:pluginId/companies/:companyId/enablement`.
 */
export function CompanyPlugins() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Plugins" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const catalogQueryKey = queryKeys.plugins.companyCatalog(selectedCompanyId ?? "");
  const {
    data: catalog,
    isLoading,
    error,
  } = useQuery({
    queryKey: catalogQueryKey,
    queryFn: () => pluginsApi.listCompanyPluginCatalog(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const toggleMutation = useMutation({
    mutationFn: (item: CompanyPluginCatalogItem) =>
      pluginsApi.setCompanyPluginEnabled(item.pluginId, selectedCompanyId!, !item.enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: catalogQueryKey });
      // Prefix match: also covers ui-contributions queries suffixed with a
      // companyId (see ui/src/plugins/slots.tsx). Without this, toggling a
      // plugin off leaves its UI contributions visible until react-query's
      // next background refetch.
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to update plugin", body: err.message, tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage plugins.</div>;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading plugins…</div>;
  }

  if (error) {
    // 403 (hidden surface / revoked access) is a navigation miss, not a crash.
    if (error instanceof ApiError && error.status === 403) {
      return <Navigate to="/company/settings" replace />;
    }
    return <div className="text-sm text-destructive">Failed to load plugins.</div>;
  }

  const items = catalog ?? [];

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Plugins</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Turn installed plugins on or off for this company. Disabling a plugin here
          hides its contributions from this company without uninstalling it.
        </p>
      </div>

      {items.length === 0 ? (
        <Card className="bg-muted/30">
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Puzzle className="mb-4 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">No plugins installed</p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              Instance admins install plugins from instance settings. Once a plugin
              is installed, it will appear here so you can enable it for this company.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="block py-0">
          <ul className="divide-y">
            {items.map((item) => {
              const pending =
                toggleMutation.isPending && toggleMutation.variables?.pluginId === item.pluginId;
              return (
                <li key={item.pluginId}>
                  <div className="flex items-start gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.displayName}</span>
                        <Badge variant="outline">v{item.version}</Badge>
                        <Badge
                          variant={item.enabled ? "default" : "secondary"}
                          className={cn(item.enabled && "bg-green-600 hover:bg-green-700")}
                        >
                          {item.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {item.locked ? (
                          <Badge variant="outline" className="gap-1">
                            <Lock className="h-3 w-3" />
                            Managed by instance
                          </Badge>
                        ) : null}
                      </div>
                      {item.description ? (
                        <p className="mt-1 truncate text-sm text-muted-foreground" title={item.description}>
                          {item.description}
                        </p>
                      ) : null}
                      {item.capabilities.length > 0 ? (
                        <p
                          className="mt-1 truncate text-xs text-muted-foreground"
                          title={item.capabilities.join(", ")}
                        >
                          Capabilities: {item.capabilities.join(", ")}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {item.enabled && item.settingsRoutePath ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/company/settings/${item.settingsRoutePath}`}>
                            <SettingsIcon className="h-4 w-4" />
                            Settings
                          </Link>
                        </Button>
                      ) : null}
                      {item.locked ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => toggleMutation.mutate(item)}
                        >
                          {pending ? "Working…" : item.enabled ? "Disable" : "Enable"}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
