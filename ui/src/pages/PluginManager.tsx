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
import { AlertTriangle, Download, FlaskConical, Plus, Power, Puzzle, RefreshCw, Settings, Sparkles, Trash } from "lucide-react";
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

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ?? null;
}

function getPluginErrorSummary(plugin: PluginRecord): string {
  return firstNonEmptyLine(plugin.lastError) ?? "Plugin entered an error state without a stored error message.";
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
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [installMode, setInstallMode] = useState<"npm" | "file">("npm");
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [installDragOver, setInstallDragOver] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");
  const [errorDetailsPlugin, setErrorDetailsPlugin] = useState<PluginRecord | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/instance/settings/heartbeats" },
      { label: "Plugins" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const examplesQuery = useQuery({
    queryKey: queryKeys.plugins.examples,
    queryFn: () => pluginsApi.listExamples(),
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
      pushToast({ title: "Plugin installed successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const installFileMutation = useMutation({
    mutationFn: (file: File) => pluginsApi.installFile(file),
    onSuccess: (record) => {
      invalidatePluginQueries();
      setInstallDialogOpen(false);
      setInstallFile(null);
      pushToast({
        title: `Installed ${record.manifestJson.displayName ?? record.packageName} v${record.version}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: "Plugin uninstalled successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to uninstall plugin", body: err.message, tone: "error" });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: "Plugin enabled", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to enable plugin", body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      invalidatePluginQueries();
      pushToast({ title: "Plugin disabled", tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to disable plugin", body: err.message, tone: "error" });
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.reinstall(pluginId),
    onSuccess: (record) => {
      invalidatePluginQueries();
      pushToast({
        title: `Reinstalled ${record.manifestJson.displayName ?? record.packageName} v${record.version}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to reinstall plugin", body: err.message, tone: "error" });
    },
  });

  const libraryQuery = useQuery({
    queryKey: queryKeys.plugins.library,
    queryFn: () => pluginsApi.listLibrary(),
    staleTime: 60_000,
  });

  const installFromLibraryMutation = useMutation({
    mutationFn: (id: string) => pluginsApi.installFromLibrary(id),
    onSuccess: (record) => {
      invalidatePluginQueries();
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.library });
      pushToast({
        title: `Installed ${record.manifestJson.displayName ?? record.packageName} v${record.version}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const installedPlugins = plugins ?? [];
  const examples = examplesQuery.data ?? [];
  const installedByPackageName = new Map(installedPlugins.map((plugin) => [plugin.packageName, plugin]));
  const examplePackageNames = new Set(examples.map((example) => example.packageName));
  const errorSummaryByPluginId = useMemo(
    () =>
      new Map(
        installedPlugins.map((plugin) => [plugin.id, getPluginErrorSummary(plugin)])
      ),
    [installedPlugins]
  );

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading plugins...</div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load plugins.</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Plugin Manager</h1>
        </div>
        
        <Dialog
          open={installDialogOpen}
          onOpenChange={(open) => {
            setInstallDialogOpen(open);
            if (!open) {
              setInstallPackage("");
              setInstallFile(null);
              setInstallDragOver(false);
            }
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Install Plugin
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Install Plugin</DialogTitle>
              <DialogDescription>
                Install from npm or upload a packed `.pcplugin` archive.
              </DialogDescription>
            </DialogHeader>

            <div className="flex gap-1 rounded-md border p-1 text-xs">
              <button
                type="button"
                className={cn(
                  "flex-1 rounded px-3 py-1.5 transition",
                  installMode === "npm"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => setInstallMode("npm")}
              >
                From npm
              </button>
              <button
                type="button"
                className={cn(
                  "flex-1 rounded px-3 py-1.5 transition",
                  installMode === "file"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
                onClick={() => setInstallMode("file")}
              >
                Upload .pcplugin
              </button>
            </div>

            <div className="grid gap-4 py-2">
              {installMode === "npm" ? (
                <div className="grid gap-2">
                  <Label htmlFor="packageName">npm Package Name</Label>
                  <Input
                    id="packageName"
                    placeholder="@paperclipai/plugin-example"
                    value={installPackage}
                    onChange={(e) => setInstallPackage(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Pulls the plugin from the npm registry. Pin a version with
                    the @ syntax: <code>my-plugin@1.2.3</code>.
                  </p>
                </div>
              ) : (
                <div className="grid gap-2">
                  <Label>Plugin archive</Label>
                  <label
                    htmlFor="pcplugin-file-input"
                    className={cn(
                      "flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-8 text-center text-sm transition",
                      installDragOver
                        ? "border-primary bg-primary/5"
                        : "hover:border-foreground/30",
                    )}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setInstallDragOver(true);
                    }}
                    onDragLeave={() => setInstallDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setInstallDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) setInstallFile(file);
                    }}
                  >
                    <input
                      id="pcplugin-file-input"
                      type="file"
                      accept=".pcplugin,application/zip,application/octet-stream"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        setInstallFile(file);
                      }}
                    />
                    {installFile ? (
                      <>
                        <span className="font-medium text-foreground">
                          {installFile.name}
                        </span>
                        <span className="mt-1 text-xs text-muted-foreground">
                          {Math.round(installFile.size / 1024)} KB — click or
                          drop another to replace
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-foreground">
                          Drop a .pcplugin file here
                        </span>
                        <span className="mt-1 text-xs text-muted-foreground">
                          or click to browse
                        </span>
                      </>
                    )}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Generate a .pcplugin from a built plugin folder with
                    <code className="ml-1">paperclipai plugin pack &lt;path&gt;</code>.
                  </p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>
                Cancel
              </Button>
              {installMode === "npm" ? (
                <Button
                  onClick={() => installMutation.mutate({ packageName: installPackage })}
                  disabled={!installPackage || installMutation.isPending}
                >
                  {installMutation.isPending ? "Installing..." : "Install"}
                </Button>
              ) : (
                <Button
                  onClick={() => installFile && installFileMutation.mutate(installFile)}
                  disabled={!installFile || installFileMutation.isPending}
                >
                  {installFileMutation.isPending ? "Uploading..." : "Upload & install"}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Plugin Library</h2>
          {libraryQuery.data?.release.tag && (
            <Badge variant="outline">
              {libraryQuery.data.repo} · {libraryQuery.data.release.tag}
            </Badge>
          )}
        </div>

        {libraryQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading plugin library…</div>
        ) : libraryQuery.error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            Failed to load plugin library: {(libraryQuery.error as Error).message}
          </div>
        ) : (libraryQuery.data?.plugins.length ?? 0) === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            No plugins found in the latest release of{" "}
            {libraryQuery.data?.repo ?? "the plugin library"}.
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {libraryQuery.data!.plugins.map((entry) => {
              const inFlight =
                installFromLibraryMutation.isPending &&
                installFromLibraryMutation.variables === entry.id;
              const isInstalled = entry.installed;
              const upgrade = entry.upgradeAvailable;
              return (
                <li key={entry.id}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {entry.displayName ?? entry.id}
                        </span>
                        <Badge variant="outline">v{entry.version}</Badge>
                        {isInstalled && !upgrade && (
                          <Badge
                            variant="default"
                            className="bg-green-600 hover:bg-green-700"
                          >
                            Installed
                          </Badge>
                        )}
                        {isInstalled && upgrade && (
                          <Badge variant="secondary">
                            Update available (you have v{entry.installedVersion})
                          </Badge>
                        )}
                        {!isInstalled && <Badge variant="secondary">Not installed</Badge>}
                      </div>
                      {entry.description && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {entry.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.id}
                        {typeof entry.sizeBytes === "number" &&
                          ` · ${Math.round(entry.sizeBytes / 1024)} KB`}
                        {entry.author && ` · ${entry.author}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!isInstalled && (
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={() => installFromLibraryMutation.mutate(entry.id)}
                          disabled={inFlight}
                        >
                          <Download className="h-4 w-4" />
                          {inFlight ? "Installing…" : "Install"}
                        </Button>
                      )}
                      {isInstalled && upgrade && (
                        <Button
                          size="sm"
                          className="gap-2"
                          onClick={() => installFromLibraryMutation.mutate(entry.id)}
                          disabled={inFlight}
                        >
                          <RefreshCw className={cn("h-4 w-4", inFlight && "animate-spin")} />
                          {inFlight ? "Updating…" : `Update to v${entry.version}`}
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
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">Available Plugins</h2>
          <Badge variant="outline">Examples</Badge>
        </div>

        {examplesQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading bundled examples...</div>
        ) : examplesQuery.error ? (
          <div className="text-sm text-destructive">Failed to load bundled examples.</div>
        ) : examples.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
            No bundled example plugins were found in this checkout.
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {examples.map((example) => {
              const installedPlugin = installedByPackageName.get(example.packageName);
              const installPending =
                installMutation.isPending &&
                installMutation.variables?.isLocalPath &&
                installMutation.variables.packageName === example.localPath;

              return (
                <li key={example.packageName}>
                  <div className="flex items-center gap-4 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{example.displayName}</span>
                        <Badge variant="outline">Example</Badge>
                        {installedPlugin ? (
                          <Badge
                            variant={installedPlugin.status === "ready" ? "default" : "secondary"}
                            className={installedPlugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""}
                          >
                            {installedPlugin.status}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Not installed</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{example.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{example.packageName}</p>
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
                              Enable
                            </Button>
                          )}
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/instance/settings/plugins/${installedPlugin.id}`}>
                              {installedPlugin.status === "ready" ? "Open Settings" : "Review"}
                            </Link>
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          disabled={installPending || installMutation.isPending}
                          onClick={() =>
                            installMutation.mutate({
                              packageName: example.localPath,
                              isLocalPath: true,
                            })
                          }
                        >
                          {installPending ? "Installing..." : "Install Example"}
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
          <h2 className="text-base font-semibold">Installed Plugins</h2>
        </div>

        {!installedPlugins.length ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Puzzle className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">No plugins installed</p>
              <p className="text-xs text-muted-foreground mt-1">
                Install a plugin to extend functionality.
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
                        to={`/instance/settings/plugins/${plugin.id}`}
                        className="font-medium hover:underline truncate block"
                        title={plugin.manifestJson.displayName ?? plugin.packageName}
                      >
                        {plugin.manifestJson.displayName ?? plugin.packageName}
                      </Link>
                      {examplePackageNames.has(plugin.packageName) && (
                        <Badge variant="outline">Example</Badge>
                      )}
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate" title={plugin.packageName}>
                        {plugin.packageName} · v{plugin.manifestJson.version ?? plugin.version}
                      </p>
                    </div>
                    <p className="text-sm text-muted-foreground truncate mt-0.5" title={plugin.manifestJson.description}>
                      {plugin.manifestJson.description || "No description provided."}
                    </p>
                    {plugin.status === "error" && (
                      <div className="mt-3 rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium text-red-700 dark:text-red-300">
                              <AlertTriangle className="h-4 w-4 shrink-0" />
                              <span>Plugin error</span>
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
                            View full error
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
                          title={plugin.status === "ready" ? "Disable" : "Enable"}
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
                        {plugin.packagePath && (
                          <Button
                            variant="outline"
                            size="icon-sm"
                            className="h-8 w-8"
                            title="Reinstall from local path (re-reads the manifest after rebuild; preserves config and state)"
                            onClick={() => reinstallMutation.mutate(plugin.id)}
                            disabled={reinstallMutation.isPending}
                          >
                            <RefreshCw
                              className={cn(
                                "h-4 w-4",
                                reinstallMutation.isPending &&
                                  reinstallMutation.variables === plugin.id &&
                                  "animate-spin",
                              )}
                            />
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="icon-sm"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          title="Uninstall"
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
                        <Link to={`/instance/settings/plugins/${plugin.id}`}>
                          <Settings className="h-4 w-4" />
                          Configure
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
            <DialogTitle>Uninstall Plugin</DialogTitle>
            <DialogDescription>
              Are you sure you want to uninstall <strong>{uninstallPluginName}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallPluginId(null)}>Cancel</Button>
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
              {uninstallMutation.isPending ? "Uninstalling..." : "Uninstall"}
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
            <DialogTitle>Error Details</DialogTitle>
            <DialogDescription>
              {errorDetailsPlugin?.manifestJson.displayName ?? errorDetailsPlugin?.packageName ?? "Plugin"} hit an error state.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium text-red-700 dark:text-red-300">
                    What errored
                  </p>
                  <p className="text-red-700/90 dark:text-red-200/90 break-words">
                    {errorDetailsPlugin ? getPluginErrorSummary(errorDetailsPlugin) : "No error summary available."}
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Full error output</p>
              <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-5 whitespace-pre-wrap break-words">
                {errorDetailsPlugin?.lastError ?? "No stored error message."}
              </pre>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorDetailsPlugin(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
