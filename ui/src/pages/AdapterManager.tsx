/**
 * @fileoverview Adapter Manager page — install, view, and manage external adapters.
 *
 * Adapters are simpler than plugins: no workers, no events, no manifests.
 * They just register a ServerAdapterModule that provides model discovery and execution.
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cpu, Plus, Power, Trash2, FolderOpen, Package, RefreshCw, Download } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi } from "@/api/adapters";
import type { AdapterInfo } from "@/api/adapters";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { queryKeys } from "@/lib/queryKeys";
import { formatCommonApiSlugZh } from "@/lib/i18n";
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
import { ChoosePathButton } from "@/components/PathInstructionsModal";
import { invalidateDynamicParser } from "@/adapters/dynamic-loader";
import { invalidateConfigSchemaCache } from "@/adapters/schema-config-fields";
import { adapterManagerPage } from "@/lib/i18n";

function AdapterRow({
  adapter,
  canRemove,
  onToggle,
  onRemove,
  onReload,
  onReinstall,
  isToggling,
  isReloading,
  isReinstalling,
  overriddenBy,
  /** Custom tooltip for the power button when adapter is enabled. */
  toggleTitleEnabled,
  /** Custom tooltip for the power button when adapter is disabled. */
  toggleTitleDisabled,
  /** Custom label for the disabled badge (defaults to "Hidden from menus"). */
  disabledBadgeLabel,
}: {
  adapter: AdapterInfo;
  canRemove: boolean;
  onToggle: (type: string, disabled: boolean) => void;
  onRemove: (type: string) => void;
  onReload?: (type: string) => void;
  onReinstall?: (type: string) => void;
  isToggling: boolean;
  isReloading?: boolean;
  isReinstalling?: boolean;
  /** When set, shows an "Overridden by …" badge (used for builtin entries). */
  overriddenBy?: string;
  toggleTitleEnabled?: string;
  toggleTitleDisabled?: string;
  disabledBadgeLabel?: string;
}) {
  return (
    <li>
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("font-medium", adapter.disabled && "text-muted-foreground line-through")}>
              {adapter.label || getAdapterLabel(adapter.type)}
            </span>
            <Badge variant="outline">{adapter.source === "external" ? adapterManagerPage.external : adapterManagerPage.builtin}</Badge>
            {adapter.source === "external" && (
              adapter.isLocalPath
                ? <span title={adapterManagerPage.installedFromLocalPath}><FolderOpen className="h-4 w-4 text-amber-500" /></span>
                : <span title={adapterManagerPage.installedFromNpm}><Package className="h-4 w-4 text-red-500" /></span>
            )}
            {adapter.version && (
              <Badge variant="secondary" className="font-mono text-[10px]">
                v{adapter.version}
              </Badge>
            )}
            {adapter.overriddenBuiltin && (
              <Badge variant="secondary" className="text-blue-600 border-blue-400">
                {adapterManagerPage.overridesBuiltIn}
              </Badge>
            )}
            {overriddenBy && (
              <Badge variant="secondary" className="text-blue-600 border-blue-400">
                {adapterManagerPage.overriddenBy(overriddenBy)}
              </Badge>
            )}
            {adapter.disabled && (
              <Badge variant="secondary" className="text-amber-600 border-amber-400">
                {disabledBadgeLabel ?? adapterManagerPage.hiddenFromMenus}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {adapter.type}
            {adapter.packageName && adapter.packageName !== adapter.type && (
              <> · {adapter.packageName}</>
            )}
            {" · "}{adapterManagerPage.modelsCount(adapter.modelsCount)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onReinstall && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              title={adapterManagerPage.titleReinstall}
              disabled={isReinstalling}
              onClick={() => onReinstall(adapter.type)}
            >
              <Download className={cn("h-4 w-4", isReinstalling && "animate-bounce")} />
            </Button>
          )}
          {onReload && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              title={adapterManagerPage.titleReload}
              disabled={isReloading}
              onClick={() => onReload(adapter.type)}
            >
              <RefreshCw className={cn("h-4 w-4", isReloading && "animate-spin")} />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon-sm"
            className="h-8 w-8"
            title={adapter.disabled
              ? (toggleTitleEnabled ?? adapterManagerPage.showInMenus)
              : (toggleTitleDisabled ?? adapterManagerPage.hideFromMenus)}
            disabled={isToggling}
            onClick={() => onToggle(adapter.type, !adapter.disabled)}
          >
            <Power className={cn("h-4 w-4", !adapter.disabled ? "text-green-600" : "text-muted-foreground")} />
          </Button>
          {canRemove && (
            <Button
              variant="outline"
              size="icon-sm"
              className="h-8 w-8 text-destructive hover:text-destructive"
              title={adapterManagerPage.titleRemove}
              onClick={() => onRemove(adapter.type)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function fetchNpmLatestVersion(packageName: string): Promise<string | null> {
  return fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.json())
    .then((data) => (typeof data?.version === "string" ? (data.version as string) : null))
    .catch(() => null);
}

function ReinstallDialog({
  adapter,
  open,
  isReinstalling,
  onConfirm,
  onCancel,
}: {
  adapter: AdapterInfo | null;
  open: boolean;
  isReinstalling: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { data: latestVersion, isLoading: isFetchingVersion } = useQuery({
    queryKey: ["npm-latest-version", adapter?.packageName],
    queryFn: () => {
      if (!adapter?.packageName) return null;
      return fetchNpmLatestVersion(adapter.packageName);
    },
    enabled: open && !!adapter?.packageName,
    staleTime: 60_000,
  });

  const isUpToDate = adapter?.version && latestVersion && adapter.version === latestVersion;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{adapterManagerPage.reinstallTitle}</DialogTitle>
          <DialogDescription>
            {adapter?.packageName
              ? adapterManagerPage.reinstallDesc(adapter.packageName)
              : adapterManagerPage.reinstallTitle}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border bg-muted/50 px-4 py-3 text-sm space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{adapterManagerPage.package}</span>
            <span className="font-mono">{adapter?.packageName}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{adapterManagerPage.current}</span>
            <span className="font-mono">
              {adapter?.version ? `v${adapter.version}` : formatCommonApiSlugZh("unknown")}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">{adapterManagerPage.latestNpm}</span>
            <span className="font-mono">
              {isFetchingVersion
                ? adapterManagerPage.checking
                : latestVersion
                  ? `v${latestVersion}`
                  : adapterManagerPage.unavailable}
            </span>
          </div>
          {isUpToDate && (
            <p className="text-xs text-muted-foreground pt-1">
              {adapterManagerPage.upToDate}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isReinstalling}>
            {adapterManagerPage.cancel}
          </Button>
          <Button disabled={isReinstalling} onClick={onConfirm}>
            {isReinstalling ? adapterManagerPage.reinstalling : adapterManagerPage.reinstall}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdapterManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [installPackage, setInstallPackage] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [isLocalPath, setIsLocalPath] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [removeType, setRemoveType] = useState<string | null>(null);
  const [reinstallTarget, setReinstallTarget] = useState<AdapterInfo | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: adapterManagerPage.breadcrumbSettings, href: "/instance/settings/general" },
      { label: adapterManagerPage.breadcrumbAdapters },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: adapters, isLoading } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all });
  };

  const installMutation = useMutation({
    mutationFn: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
      adaptersApi.install(params),
    onSuccess: (result) => {
      invalidate();
      setInstallDialogOpen(false);
      setInstallPackage("");
      setInstallVersion("");
      setIsLocalPath(false);
      pushToast({
        title: adapterManagerPage.toastInstalled,
        body: adapterManagerPage.toastInstalledBody(result.type, result.version),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastInstallFailed, body: err.message, tone: "error" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.remove(type),
    onSuccess: () => {
      invalidate();
      pushToast({ title: adapterManagerPage.toastRemoved, tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastRemovalFailed, body: err.message, tone: "error" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ type, disabled }: { type: string; disabled: boolean }) =>
      adaptersApi.setDisabled(type, disabled),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastToggleFailed, body: err.message, tone: "error" });
    },
  });

  const overrideMutation = useMutation({
    mutationFn: ({ type, paused }: { type: string; paused: boolean }) =>
      adaptersApi.setOverridePaused(type, paused),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastOverrideToggleFailed, body: err.message, tone: "error" });
    },
  });

  const reloadMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reload(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: adapterManagerPage.toastReloaded,
        body: adapterManagerPage.toastReloadedBody(result.type, result.version),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastReloadFailed, body: err.message, tone: "error" });
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reinstall(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: adapterManagerPage.toastReinstalled,
        body: adapterManagerPage.toastReinstalledBody(result.type, result.version),
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: adapterManagerPage.toastReinstallFailed, body: err.message, tone: "error" });
    },
  });

  const builtinAdapters = (adapters ?? []).filter((a) => a.source === "builtin");
  const externalAdapters = (adapters ?? []).filter((a) => a.source === "external");

  // External adapters that override a builtin type.  The server only returns
  // one entry per type (the external), so we synthesize a builtin row for
  // the builtins section so users can see which builtins are affected.
  const overriddenBuiltins = (adapters ?? [])
    .filter((a) => a.source === "external" && a.overriddenBuiltin)
    .filter((a) => !builtinAdapters.some((b) => b.type === a.type))
    .map((a) => ({
      type: a.type,
      label: getAdapterLabel(a.type),
      overriddenBy: [
        a.packageName,
        a.version ? `v${a.version}` : undefined,
      ].filter(Boolean).join(" "),
      overridePaused: !!a.overridePaused,
      menuDisabled: !!a.disabled,
    }));

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">{adapterManagerPage.loadingAdapters}</div>;

  const isMutating = installMutation.isPending || removeMutation.isPending || toggleMutation.isPending || overrideMutation.isPending || reloadMutation.isPending || reinstallMutation.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{adapterManagerPage.title}</h1>
          <Badge variant="outline" className="text-amber-600 border-amber-400">
            {adapterManagerPage.alphaBadge}
          </Badge>
        </div>

        <Dialog open={installDialogOpen} onOpenChange={setInstallDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              {adapterManagerPage.installAdapter}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{adapterManagerPage.installDialogTitle}</DialogTitle>
              <DialogDescription>
                {adapterManagerPage.installDialogDescBefore}{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">createServerAdapter()</code>
                {adapterManagerPage.installDialogDescAfter}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              {/* Source toggle */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    !isLocalPath
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                  onClick={() => setIsLocalPath(false)}
                >
                  <Package className="h-3.5 w-3.5" />
                  {adapterManagerPage.npmPackage}
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    isLocalPath
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                  onClick={() => setIsLocalPath(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {adapterManagerPage.localPath}
                </button>
              </div>

              {isLocalPath ? (
                /* Local path input */
                <div className="grid gap-2">
                  <Label htmlFor="adapterLocalPath">{adapterManagerPage.pathLabel}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="adapterLocalPath"
                      className="flex-1 font-mono text-xs"
                      placeholder={adapterManagerPage.pathPlaceholder}
                      value={installPackage}
                      onChange={(e) => setInstallPackage(e.target.value)}
                    />
                    <ChoosePathButton />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {adapterManagerPage.pathHint}
                  </p>
                </div>
              ) : (
                /* npm package input */
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="adapterPackageName">{adapterManagerPage.packageNameLabel}</Label>
                    <Input
                      id="adapterPackageName"
                      placeholder={adapterManagerPage.packageNamePlaceholder}
                      value={installPackage}
                      onChange={(e) => setInstallPackage(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="adapterVersion">{adapterManagerPage.versionLabel}</Label>
                    <Input
                      id="adapterVersion"
                      placeholder={adapterManagerPage.versionPlaceholder}
                      value={installVersion}
                      onChange={(e) => setInstallVersion(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInstallDialogOpen(false)}>{adapterManagerPage.cancel}</Button>
              <Button
                onClick={() =>
                  installMutation.mutate({
                    packageName: installPackage,
                    version: installVersion || undefined,
                    isLocalPath,
                  })
                }
                disabled={!installPackage || installMutation.isPending}
              >
                {installMutation.isPending ? adapterManagerPage.installing : adapterManagerPage.install}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Alpha notice */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{adapterManagerPage.alphaWarning}</p>
            <p className="text-muted-foreground">
              {adapterManagerPage.alphaWarningDesc}
            </p>
          </div>
        </div>
      </div>

      {/* External adapters */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{adapterManagerPage.externalAdapters}</h2>
        </div>

        {externalAdapters.length === 0 ? (
          <Card className="bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-10">
              <Cpu className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">{adapterManagerPage.noExternalAdapters}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {adapterManagerPage.noExternalAdaptersDesc}
              </p>
            </CardContent>
          </Card>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {externalAdapters.map((adapter) => {
              const isBuiltinOverride = adapter.overriddenBuiltin;
              const overridePaused = isBuiltinOverride && !!adapter.overridePaused;

              // For overridden builtins, the power button controls the
              // override pause state (not server menu visibility).
              const effectiveAdapter: AdapterInfo = isBuiltinOverride
                ? { ...adapter, disabled: overridePaused ?? false }
                : adapter;

              return (
                <AdapterRow
                  key={adapter.type}
                  adapter={effectiveAdapter}
                  canRemove={true}
                  onToggle={
                    isBuiltinOverride
                      ? (type, disabled) => overrideMutation.mutate({ type, paused: disabled })
                      : (type, disabled) => toggleMutation.mutate({ type, disabled })
                  }
                  onRemove={(type) => setRemoveType(type)}
                  onReload={(type) => reloadMutation.mutate(type)}
                  onReinstall={!adapter.isLocalPath ? (type) => setReinstallTarget(adapter) : undefined}
                  isToggling={isBuiltinOverride ? overrideMutation.isPending : toggleMutation.isPending}
                  isReloading={reloadMutation.isPending}
                  isReinstalling={reinstallMutation.isPending}
                  toggleTitleDisabled={isBuiltinOverride ? adapterManagerPage.titlePauseOverride : undefined}
                  toggleTitleEnabled={isBuiltinOverride ? adapterManagerPage.titleResumeOverride : undefined}
                  disabledBadgeLabel={isBuiltinOverride ? adapterManagerPage.overridePaused : undefined}
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* Built-in adapters */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">{adapterManagerPage.builtinAdapters}</h2>
        </div>

        {builtinAdapters.length === 0 && overriddenBuiltins.length === 0 ? (
          <div className="text-sm text-muted-foreground">{adapterManagerPage.noBuiltinAdapters}</div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {builtinAdapters.map((adapter) => (
              <AdapterRow
                key={adapter.type}
                adapter={adapter}
                canRemove={false}
                onToggle={(type, disabled) => toggleMutation.mutate({ type, disabled })}
                onRemove={() => {}}
                isToggling={isMutating}
              />
            ))}
            {overriddenBuiltins.map((virtual) => (
              <AdapterRow
                key={virtual.type}
                adapter={{
                  type: virtual.type,
                  label: virtual.label,
                  source: "builtin",
                  modelsCount: 0,
                  loaded: true,
                  disabled: virtual.menuDisabled,
                  capabilities: {
                    supportsInstructionsBundle: false,
                    supportsSkills: false,
                    supportsLocalAgentJwt: false,
                    requiresMaterializedRuntimeSkills: false,
                    supportsModelProfiles: false,
                  },
                }}
                canRemove={false}
                onToggle={(type, disabled) => toggleMutation.mutate({ type, disabled })}
                onRemove={() => {}}
                isToggling={isMutating}
                overriddenBy={virtual.overridePaused ? undefined : virtual.overriddenBy}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Remove confirmation */}
      <Dialog
        open={removeType !== null}
        onOpenChange={(open) => { if (!open) setRemoveType(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{adapterManagerPage.removeTitle}</DialogTitle>
            <DialogDescription>
              {removeType ? adapterManagerPage.removeDesc(removeType) : adapterManagerPage.removeTitle}
              {removeType && adapters?.find((a) => a.type === removeType)?.packageName && (
                <> {adapterManagerPage.removeDescNpmCleanup}</>
              )}
              {" "}{adapterManagerPage.removeDescCannotUndo}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveType(null)}>{adapterManagerPage.cancel}</Button>
            <Button
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => {
                if (removeType) {
                  removeMutation.mutate(removeType, {
                    onSettled: () => setRemoveType(null),
                  });
                }
              }}
            >
              {removeMutation.isPending ? adapterManagerPage.removing : adapterManagerPage.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Reinstall confirmation */}
      <ReinstallDialog
        adapter={reinstallTarget}
        open={reinstallTarget !== null}
        isReinstalling={reinstallMutation.isPending}
        onConfirm={() => {
          if (reinstallTarget) {
            reinstallMutation.mutate(reinstallTarget.type, {
              onSettled: () => setReinstallTarget(null),
            });
          }
        }}
        onCancel={() => setReinstallTarget(null)}
      />
    </div>
  );
}
