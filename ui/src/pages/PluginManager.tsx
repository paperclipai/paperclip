/**
 * @fileoverview Plugin Manager page — admin UI for discovering,
 * installing, enabling/disabling, and uninstalling plugins.
 *
 * @see PLUGIN_SPEC.md §9 — Plugin Marketplace / Manager
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@/lib/router";
import { Puzzle, Settings, Trash, CheckCircle2, XCircle, Power, RefreshCw, Plus } from "lucide-react";
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
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

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
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  
  const [installPackage, setInstallPackage] = useState("");
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [uninstallPluginId, setUninstallPluginId] = useState<string | null>(null);
  const [uninstallPluginName, setUninstallPluginName] = useState<string>("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/settings" },
      { label: "Plugins" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: plugins, isLoading, error } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });

  const installMutation = useMutation({
    mutationFn: (packageName: string) => pluginsApi.install({ packageName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      setInstallDialogOpen(false);
      setInstallPackage("");
      pushToast({ title: "Plugin installed successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to install plugin", body: err.message, tone: "error" });
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.uninstall(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      pushToast({ title: "Plugin uninstalled successfully", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to uninstall plugin", body: err.message, tone: "error" });
    },
  });

  const enableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.enable(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      pushToast({ title: "Plugin enabled", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to enable plugin", body: err.message, tone: "error" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.disable(pluginId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.all });
      pushToast({ title: "Plugin disabled", tone: "info" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to disable plugin", body: err.message, tone: "error" });
    },
  });

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading plugins...</div>;
  if (error) return <div className="p-4 text-sm text-destructive">Failed to load plugins.</div>;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Plugin Manager</h1>
        </div>
        
        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
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
                Enter the NPM package name of the plugin you wish to install.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="packageName">NPM Package Name</Label>
                <Input
                  id="packageName"
                  placeholder="@paperclipai/plugin-example"
                  value={installPackage}
                  onChange={(e) => setInstallPackage(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>Cancel</Button>
              <Button 
                onClick={() => installMutation.mutate(installPackage)}
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? "Installing..." : "Install"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {!plugins || plugins.length === 0 ? (
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
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <div className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div>
                    <Link
                      to={`/settings/plugins/${plugin.id}`}
                      className="font-medium hover:underline truncate block"
                      title={plugin.manifestJson.displayName ?? plugin.packageName}
                    >
                      {plugin.manifestJson.displayName ?? plugin.packageName}
                    </Link>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate" title={plugin.packageName}>
                      {plugin.packageName} · v{plugin.manifestJson.version ?? plugin.version}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground truncate mt-0.5" title={plugin.manifestJson.description}>
                    {plugin.manifestJson.description || "No description provided."}
                  </p>
                </div>
                <Badge
                  variant={
                    plugin.status === "ready"
                      ? "default"
                      : plugin.status === "error" && plugin.lastError?.startsWith("disabled_by_operator")
                        ? "secondary"
                        : plugin.status === "error"
                          ? "destructive"
                          : "secondary"
                  }
                  className={cn(
                    "shrink-0",
                    plugin.status === "ready" ? "bg-green-600 hover:bg-green-700" : ""
                  )}
                >
                  {plugin.status === "error" && plugin.lastError?.startsWith("disabled_by_operator")
                    ? "disabled"
                    : plugin.status}
                </Badge>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="icon"
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
                    <Power className={`h-4 w-4 ${plugin.status === "ready" ? "text-green-600" : ""}`} />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 text-destructive"
                    title="Uninstall"
                    onClick={() => {
                      setUninstallPluginId(plugin.id);
                      setUninstallPluginName(plugin.manifestJson.displayName ?? plugin.packageName);
                    }}
                    disabled={uninstallMutation.isPending}
                  >
                    <Trash className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Settings" asChild>
                    <Link to={`/settings/plugins/${plugin.id}`}>
                      <Settings className="h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

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
    </div>
  );
}
