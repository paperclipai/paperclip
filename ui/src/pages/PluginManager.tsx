import { getPageValueLabel } from "@/pages/tools/shared";
import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
/**
 * @fileoverview Plugin Manager page — admin UI for discovering,
 * installing, enabling/disabling, and uninstalling plugins.
 *
 * @see PLUGIN_SPEC.md §9 — Plugin Marketplace / Manager
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PluginRecord } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { AlertTriangle, FlaskConical, Plus, Power, Puzzle, Settings, Trash } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecord): string {
  return firstNonEmptyLine(plugin.lastError) ?? translateAgentPage("agents:plugin_entered_an_error_state_without_a_stored");
}

function isExperimentalPluginIdentity(input: {
  packageName?: string | null;
  packagePath?: string | null;
  manifestJson?: PluginRecord["manifestJson"] | null;
  bundledExperimental?: boolean;
}) {
  if (input.bundledExperimental) return true;

  const packageName = input.packageName ?? "";
  const packagePath = input.packagePath ?? "";
  if (packageName.includes("sandbox") || packagePath.includes("sandbox")) return true;
  return input.manifestJson?.environmentDrivers?.some((driver) => driver.kind === "sandbox_provider") === true;
}

function ExperimentalBadge() {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 dark:text-amber-200"
    >{translateAgentPage("agents:experimental")}</Badge>
  );
}

/**
 * PluginManager page component.
 *
 * Provides a management UI for the Paperclip plugin system:
 * - Lists all installed plugins with their status, version, and category badges.
 * - Allows installing new plugins by npm package name.
 * - Provides per-plugin actions: enable, disable, navigate to settings.
 * - Uninstall with a two-step confirmation dialog to prevent accidental removal.
 *
 * Data flow:
 * - Reads from `GET /api/plugins` via `pluginsApi.list()`.
 * - Mutations (install / uninstall / enable / disable) invalidate
 *   `queryKeys.plugins.all` so the list refreshes automatically.
 *
 * @see PluginSettings — linked from the Settings icon on each plugin row.
 * @see doc/plugins/PLUGIN_SPEC.md §3 — Plugin Lifecycle for status semantics.
 */
export function PluginManager() {
  const { t: translateAgentPage } = useTranslation("agents");
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecord | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? translateAgentPage("agents:organization"), href: "/dashboard" },
      { label: translateAgentPage("agents:settings"), href: "/company/settings" },
      { label: translateAgentPage("agents:plugins") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, translateAgentPage]);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const { data: plugins, isLoading, error } = pluginsQuery;
  const pluginsView = useQueryView(pluginsQuery);

  const bundledQuery = useQuery({
    queryKey: queryKeys.plugins.examples,
    queryFn: () => pluginsApi.listBundled(),
  });
  const bundledView = useQueryView(bundledQuery);

  const invalidatePluginQueries = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.examples });
    queryClient.invalidateQueries({ queryKey: queryKeys.plugins.uiContributions });
  };

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
      pluginsApi.install(params),
    onSuccess: () => {
      invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallPackage("");
      pushToast({ title: translateAgentPage("agents:plugin_installed_successfully"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: translateAgentPage("agents:failed_to_install_plugin"), body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: translateAgentPage("agents:plugin_uninstalled_successfully"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: translateAgentPage("agents:failed_to_uninstall_plugin"), body: err.message, tone: "error" });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: translateAgentPage("agents:plugin_enabled"), tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: translateAgentPage("agents:failed_to_enable_plugin"), body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: translateAgentPage("agents:plugin_disabled"), tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: translateAgentPage("agents:failed_to_disable_plugin"), body: err.message, tone: "error" });
    },
  });

  const installedPlugins = plugins ?? [];
  const bundledPlugins = bundledQuery.data ?? [];
  const installedByPackageName = new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin]));
  const bundledByPackageName = new Map(bundledPlugins.map((plugin) => [plugin.packageName, plugin]));
  // Scope the in-section banner to bundled (local-path) installs so an npm-dialog
  // install failure does not surface its error in the bundled-plugins section.
  const installErrorMessage = installMutation.variables?.isLocalPath
    ? installMutation.error?.message ?? null
    : null;
  const errorSummaryByPluginId = useMemo(
    () =>
      new Map(
        installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])
      ),
    [installedPlugins]
  );

  if (isLoading || pluginsView.kind === "reconnecting") {
    return <div className="p-4 text-sm text-muted-foreground">{translateAgentPage("agents:loading_plugins")}</div>;
  }
  if (pluginsView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={error}
        action={translateAgentPage("agents:load_plugins")}
        onRetry={pluginsView.retry}
        retrying={pluginsView.isFetching}
      />
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{translateAgentPage("agents:plugin_manager")}</h1>
        </div>
        
        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />{translateAgentPage("agents:install_plugin")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{translateAgentPage("agents:install_plugin")}</DialogTitle>
              <DialogDescription>{translateAgentPage("agents:enter_the_npm_package_name_of_the_plugin")}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="packageName">{translateAgentPage("agents:npm_package_name")}</Label>
                <Input
                  id="packageName"
                  placeholder="@paperclipai/plugin-example"
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>{translateAgentPage("agents:cancel")}</Button>
              <Button
                onClick={() => installMutation.mutate({ packageName: installPackage })}
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? translateAgentPage("agents:installing_1106a2") : translateAgentPage("agents:install")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{translateAgentPage("agents:plugins_are_alpha")}</p>
            <p className="text-muted-foreground">{translateAgentPage("agents:the_plugin_runtime_and_api_surface_are_still")}</p>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{translateAgentPage("agents:available_plugins")}</h2>
          <Badge variant="outline">{translateAgentPage("agents:bundled")}</Badge>
        </div>

        {installErrorMessage && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive whitespace-pre-wrap break-words">
            {installErrorMessage}
          </div>
        )}

        {bundledQuery.isLoading || bundledView.kind === "reconnecting" ? (
          <div className="text-sm text-muted-foreground">{translateAgentPage("agents:loading_bundled_plugins")}</div>
        ) : bundledView.kind === "error" ? (
          <QueryErrorState
            error={bundledQuery.error}
            action={translateAgentPage("agents:load_bundled_plugins")}
            onRetry={bundledView.retry}
            retrying={bundledView.isFetching}
          />
        ) : bundledPlugins.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">{translateAgentPage("agents:no_bundled_plugins_were_found_in_this_checkout")}</div>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {bundledPlugins.map((bundledPlugin) => {
              const installedPlugin = installedByPackageName.get(bundledPlugin.packageName);
              const installPending =
                installMutation.isPending &&
                installMutation.variables?.isLocalPath &&
                installMutation.variables.packageName === bundledPlugin.localPath;

              return (
                <li key={bundledPlugin.packageName}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{bundledPlugin.displayName}</span>
                        <Badge variant="outline">
                          {bundledPlugin.tag === "first-party" ? translateAgentPage("agents:first_party") : translateAgentPage("agents:example")}
                        </Badge>
                        {isExperimentalPluginIdentity({
                          packageName: bundledPlugin.packageName,
                          packagePath: bundledPlugin.localPath,
                          bundledExperimental: bundledPlugin.experimental,
                        }) && <ExperimentalBadge />}
                        {installedPlugin ? (
                          <Badge
                            variant={installedPlugin.status === "ready" ? "default" : "secondary"}
                            className={installedPlugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""}
                          >
                            {getPageValueLabel(installedPlugin.status)}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{translateAgentPage("agents:not_installed")}</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{bundledPlugin.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{bundledPlugin.packageName}</p>
                      {installPending && !bundledPlugin.hasBuiltEntrypoints && (
                        <p className="mt-2 text-xs text-muted-foreground">{translateAgentPage("agents:building_plugin")}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {installedPlugin ? (
                        <>
                          {installedPlugin.status !== "ready" && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={enableMutation.isPending}
                              onClick={() => enableMutation.mutate(installedPlugin.id)}
                            >{translateAgentPage("agents:enable")}</Button>
                          )}
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/company/settings/instance/plugins/${installedPlugin.id}`}>
                              {installedPlugin.status === "ready" ? translateAgentPage("agents:open_settings") : translateAgentPage("agents:review")}
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          disabled={installPending || installMutation.isPending}
                          onClick={() =>
                            installMutation.mutate({
                              packageName: bundledPlugin.localPath,
                              isLocalPath: true,
                            })
                          }
                        >
                          {installPending ? translateAgentPage("agents:installing_1106a2") : translateAgentPage("agents:install")}
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
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{translateAgentPage("agents:installed_plugins")}</h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">{translateAgentPage("agents:no_plugins_installed")}</p>
              <p className="text-xs text-muted-foreground mt-1">{translateAgentPage("agents:install_a_plugin_to_extend_functionality")}</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="block py-0">
          <ul className="divide-y">
            {installedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <div className="flex items-start gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/company/settings/instance/plugins/${plugin.id}`}
                        className="font-medium hover:underline truncate block"
                        title={plugin.manifestJson.displayName ?? plugin.packageName}
                      >
                        {plugin.manifestJson.displayName ?? plugin.packageName}
                      </Link>
                      {bundledByPackageName.has(plugin.packageName) && (
                        <Badge variant="outline">
                          {bundledByPackageName.get(plugin.packageName)?.tag === "first-party"
                            ? translateAgentPage("agents:first_party")
                            : translateAgentPage("agents:example")}
                        </Badge>
                      )}
                      {isExperimentalPluginIdentity({
                        packageName: plugin.packageName,
                        packagePath: plugin.packagePath,
                        manifestJson: plugin.manifestJson,
                        bundledExperimental: bundledByPackageName.get(plugin.packageName)?.experimental,
                      }) && <ExperimentalBadge />}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate" title={plugin.packageName}>
                        {plugin.packageName} · v{plugin.manifestJson.version ?? plugin.version}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5" title={plugin.manifestJson.description}>
                      {plugin.manifestJson.description || translateAgentPage("agents:no_description_provided")}
                    </p>
                    {plugin.status === "error" && (
                      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                              <AlertTriangle className="h-4 w-4 shrink-0" />
                              <span>{translateAgentPage("agents:plugin_error")}</span>
                            </div>
                            <p
                              className="mt-1 text-sm text-red-700/90 dark:text-red-200/90 break-words"
                              title={plugin.lastError ?? undefined}
                            >
                              {errorSummaryByPluginId.get(plugin.id)}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-500/30 bg-background/60 text-red-700 hover:bg-red-500/10 hover:text-red-800 dark:text-red-200 dark:hover:text-red-100"
                            onClick={() => setErrorDetailsPlugin(plugin)}
                          >{translateAgentPage("agents:view_full_error")}</Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 self-center">
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={
                            plugin.status === "ready"
                              ? "default"
                              : plugin.status === "error"
                                ? "destructive"
                              : "secondary"
                          }
                          className={cn(
                            "shrink-0",
                            plugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""
                          )}
                        >
                          {getPageValueLabel(plugin.status)}
                        </Badge>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8"
                          title={plugin.status === "ready" ? translateAgentPage("agents:disable") : translateAgentPage("agents:enable")}
                          onClick={() => {
                            if (plugin.status === "ready") {
                              disableMutation.mutate(plugin.id);
                            } else {
                              enableMutation.mutate(plugin.id);
                            }
                          }}
                          disabled={enableMutation.isPending || disableMutation.isPending}
                        >
                          <Power className={cn("h-4 w-4", plugin.status === "ready" ? "text-green-600" : "")} />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title={translateAgentPage("agents:uninstall")}
                          onClick={() => {
                            setUninstallPluginId(plugin.id);
                            setUninstallPluginName(plugin.manifestJson.displayName ?? plugin.packageName);
                          }}
                          disabled={uninstallMutation.isPending}
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button variant="outline" size="sm" className="mt-2 h-8" asChild>
                        <Link to={`/company/settings/instance/plugins/${plugin.id}`}>
                          <Settings className="h-4 w-4" />{translateAgentPage("agents:configure")}</Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          </Card>
        )}
      </section>

      <Dialog
        open={uninstallPluginId !== null}
        onOpenChange={(open) => { if (!open) setUninstallPluginId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateAgentPage("agents:uninstall_plugin")}</DialogTitle>
            <DialogDescription>{translateAgentPage("agents:are_you_sure_you_want_to_uninstall")}{" "}<strong>{uninstallPluginName}</strong>{translateAgentPage("agents:this_action_cannot_be_undone")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPluginId(null)}>{translateAgentPage("agents:cancel")}</Button>
            <Button
              variant="destructive"
              disabled={uninstallMutation.isPending}
              onClick={() => {
                if (uninstallPluginId) {
                  uninstallMutation.mutate(uninstallPluginId, {
                    onSettled: () => setUninstallPluginId(null),
                  });
                }
              }}
            >
              {uninstallMutation.isPending ? translateAgentPage("agents:uninstalling") : translateAgentPage("agents:uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={errorDetailsPlugin !== null}
        onOpenChange={(open) => { if (!open) setErrorDetailsPlugin(null); }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{translateAgentPage("agents:error_details")}</DialogTitle>
            <DialogDescription>
              {errorDetailsPlugin?.manifestJson.displayName ?? errorDetailsPlugin?.packageName ?? translateAgentPage("agents:plugin")}{" "}{translateAgentPage("agents:hit_an_error_state")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">{translateAgentPage("agents:what_errored")}</p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : translateAgentPage("agents:no_error_summary_available")}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">{translateAgentPage("agents:full_error_output")}</p>
              <pre className="max-h-(--sz-50vh) overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ?? finalPagesT("final-pages:No_stored_error_message_424cc4")}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>{translateAgentPage("agents:close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
