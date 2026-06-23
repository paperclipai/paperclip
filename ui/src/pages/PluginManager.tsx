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
import { useTranslation, t } from "@/i18n";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecord): string {
  return (
    firstNonEmptyLine(plugin.lastError) ??
    t("pages.pluginManager.errorNoStoredMessage", {
      defaultValue: "Plugin entered an error state without a stored error message.",
    })
  );
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
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/10 dark:text-amber-200"
    >
      {t("pages.pluginManager.experimentalBadge", { defaultValue: "Experimental" })}
    </Badge>
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
  const { t } = useTranslation();
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
      {
        label: selectedCompany?.name ?? t("pages.pluginManager.breadcrumbCompany", { defaultValue: "Company" }),
        href: "/dashboard",
      },
      { label: t("pages.pluginManager.breadcrumbSettings", { defaultValue: "Settings" }), href: "/company/settings" },
      {
        label: t("pages.pluginManager.breadcrumbInstanceSettings", { defaultValue: "Instance settings" }),
        href: "/company/settings/instance/general",
      },
      { label: t("pages.pluginManager.breadcrumbPlugins", { defaultValue: "Plugins" }) },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const bundledQuery = useQuery({
    queryKey: queryKeys.plugins.examples,
    queryFn: () => pluginsApi.listBundled(),
  });

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
      pushToast({
        title: t("pages.pluginManager.toastInstallSuccess", { defaultValue: "Plugin installed successfully" }),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({
        title: t("pages.pluginManager.toastInstallError", { defaultValue: "Failed to install plugin" }),
        body: err.message,
        tone: "error",
      });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({
        title: t("pages.pluginManager.toastUninstallSuccess", { defaultValue: "Plugin uninstalled successfully" }),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({
        title: t("pages.pluginManager.toastUninstallError", { defaultValue: "Failed to uninstall plugin" }),
        body: err.message,
        tone: "error",
      });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({
        title: t("pages.pluginManager.toastEnableSuccess", { defaultValue: "Plugin enabled" }),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({
        title: t("pages.pluginManager.toastEnableError", { defaultValue: "Failed to enable plugin" }),
        body: err.message,
        tone: "error",
      });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({
        title: t("pages.pluginManager.toastDisableSuccess", { defaultValue: "Plugin disabled" }),
        tone: "info",
      });
    },
    onError: (err: Error) => {
      pushToast({
        title: t("pages.pluginManager.toastDisableError", { defaultValue: "Failed to disable plugin" }),
        body: err.message,
        tone: "error",
      });
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

  if (isLoading)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("pages.pluginManager.loadingPlugins", { defaultValue: "Loading plugins..." })}
      </div>
    );
  if (error)
    return (
      <div className="p-4 text-sm text-destructive">
        {t("pages.pluginManager.loadPluginsError", { defaultValue: "Failed to load plugins." })}
      </div>
    );

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">
            {t("pages.pluginManager.pageTitle", { defaultValue: "Plugin Manager" })}
          </h1>
        </div>

        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              {t("pages.pluginManager.installPluginButton", { defaultValue: "Install Plugin" })}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("pages.pluginManager.installDialogTitle", { defaultValue: "Install Plugin" })}
              </DialogTitle>
              <DialogDescription>
                {t("pages.pluginManager.installDialogDescription", {
                  defaultValue: "Enter the npm package name of the plugin you wish to install.",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="packageName">
                  {t("pages.pluginManager.npmPackageNameLabel", { defaultValue: "npm Package Name" })}
                </Label>
                <Input
                  id="packageName"
                  placeholder="@paperclipai/plugin-example"
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>
                {t("pages.pluginManager.cancelButton", { defaultValue: "Cancel" })}
              </Button>
              <Button
                onClick={() => installMutation.mutate({ packageName: installPackage })}
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending
                  ? t("pages.pluginManager.installingButton", { defaultValue: "Installing..." })
                  : t("pages.pluginManager.installButton", { defaultValue: "Install" })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">
              {t("pages.pluginManager.alphaTitle", { defaultValue: "Plugins are alpha." })}
            </p>
            <p className="text-muted-foreground">
              {t("pages.pluginManager.alphaDescription", {
                defaultValue:
                  "The plugin runtime and API surface are still changing. Expect breaking changes while this feature settles.",
              })}
            </p>
          </div>
        </div>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">
            {t("pages.pluginManager.availablePluginsHeading", { defaultValue: "Available Plugins" })}
          </h2>
          <Badge variant="outline">
            {t("pages.pluginManager.bundledBadge", { defaultValue: "Bundled" })}
          </Badge>
        </div>

        {installErrorMessage && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] px-4 py-3 text-sm text-destructive whitespace-pre-wrap break-words">
            {installErrorMessage}
          </div>
        )}

        {bundledQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">
            {t("pages.pluginManager.loadingBundledPlugins", { defaultValue: "Loading bundled plugins..." })}
          </div>
        ) : bundledQuery.error ? (
          <div className="text-sm text-destructive">
            {t("pages.pluginManager.loadBundledPluginsError", { defaultValue: "Failed to load bundled plugins." })}
          </div>
        ) : bundledPlugins.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            {t("pages.pluginManager.noBundledPlugins", {
              defaultValue: "No bundled plugins were found in this checkout.",
            })}
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
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
                          {bundledPlugin.tag === "first-party"
                            ? t("pages.pluginManager.firstPartyBadge", { defaultValue: "First-party" })
                            : t("pages.pluginManager.exampleBadge", { defaultValue: "Example" })}
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
                            {installedPlugin.status}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            {t("pages.pluginManager.notInstalledBadge", { defaultValue: "Not installed" })}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{bundledPlugin.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{bundledPlugin.packageName}</p>
                      {installPending && !bundledPlugin.hasBuiltEntrypoints && (
                        <p className="mt-2 text-xs text-muted-foreground">Building plugin...</p>
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
                            >
                              {t("pages.pluginManager.enableButton", { defaultValue: "Enable" })}
                            </Button>
                          )}
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/company/settings/instance/plugins/${installedPlugin.id}`}>
                              {installedPlugin.status === "ready"
                                ? t("pages.pluginManager.openSettingsButton", { defaultValue: "Open Settings" })
                                : t("pages.pluginManager.reviewButton", { defaultValue: "Review" })}
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
                          {installPending
                            ? t("pages.pluginManager.installingButton", { defaultValue: "Installing..." })
                            : t("pages.pluginManager.installButton", { defaultValue: "Install" })}
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">
            {t("pages.pluginManager.installedPluginsHeading", { defaultValue: "Installed Plugins" })}
          </h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">
                {t("pages.pluginManager.noPluginsInstalled", { defaultValue: "No plugins installed" })}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("pages.pluginManager.noPluginsInstalledHint", {
                  defaultValue: "Install a plugin to extend functionality.",
                })}
              </p>
            </CardContent>
          </Card>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
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
                            ? t("pages.pluginManager.firstPartyBadge", { defaultValue: "First-party" })
                            : t("pages.pluginManager.exampleBadge", { defaultValue: "Example" })}
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
                      {plugin.manifestJson.description ||
                        t("pages.pluginManager.noDescription", { defaultValue: "No description provided." })}
                    </p>
                    {plugin.status === "error" && (
                      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                              <AlertTriangle className="h-4 w-4 shrink-0" />
                              <span>{t("pages.pluginManager.pluginErrorLabel", { defaultValue: "Plugin error" })}</span>
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
                          >
                            {t("pages.pluginManager.viewFullErrorButton", { defaultValue: "View full error" })}
                          </Button>
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
                          {plugin.status}
                        </Badge>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8"
                          title={
                            plugin.status === "ready"
                              ? t("pages.pluginManager.disableTitle", { defaultValue: "Disable" })
                              : t("pages.pluginManager.enableTitle", { defaultValue: "Enable" })
                          }
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
                          title={t("pages.pluginManager.uninstallTitle", { defaultValue: "Uninstall" })}
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
                          <Settings className="h-4 w-4" />
                          {t("pages.pluginManager.configureButton", { defaultValue: "Configure" })}
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={uninstallPluginId !== null}
        onOpenChange={(open) => { if (!open) setUninstallPluginId(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("pages.pluginManager.uninstallDialogTitle", { defaultValue: "Uninstall Plugin" })}
            </DialogTitle>
            <DialogDescription>
              {t("pages.pluginManager.uninstallConfirmPrefix", { defaultValue: "Are you sure you want to uninstall" })}{" "}
              <strong>{uninstallPluginName}</strong>
              {t("pages.pluginManager.uninstallConfirmSuffix", {
                defaultValue: "? This action cannot be undone.",
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPluginId(null)}>
              {t("pages.pluginManager.cancelButton", { defaultValue: "Cancel" })}
            </Button>
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
              {uninstallMutation.isPending
                ? t("pages.pluginManager.uninstallingButton", { defaultValue: "Uninstalling..." })
                : t("pages.pluginManager.uninstallButton", { defaultValue: "Uninstall" })}
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
            <DialogTitle>
              {t("pages.pluginManager.errorDetailsTitle", { defaultValue: "Error Details" })}
            </DialogTitle>
            <DialogDescription>
              {t("pages.pluginManager.errorDetailsDescription", {
                name:
                  errorDetailsPlugin?.manifestJson.displayName ??
                  errorDetailsPlugin?.packageName ??
                  t("pages.pluginManager.errorDetailsFallbackName", { defaultValue: "Plugin" }),
                defaultValue: "{{name}} hit an error state.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">
                    {t("pages.pluginManager.whatErroredLabel", { defaultValue: "What errored" })}
                  </p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin
                      ? getPluginErrorSummary(errorDetailsPlugin)
                      : t("pages.pluginManager.noErrorSummary", { defaultValue: "No error summary available." })}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {t("pages.pluginManager.fullErrorOutputLabel", { defaultValue: "Full error output" })}
              </p>
              <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ??
                  t("pages.pluginManager.noStoredErrorMessage", { defaultValue: "No stored error message." })}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
              {t("pages.pluginManager.closeButton", { defaultValue: "Close" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
