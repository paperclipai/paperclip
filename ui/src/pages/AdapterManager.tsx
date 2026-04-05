/**
 * @fileoverview Adapter Manager page — install, view, and manage external adapters.
 *
 * Adapters are simpler than plugins: no workers, no events, no manifests.
 * They just register a ServerAdapterModule that provides model discovery and execution.
 */
import React, { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cpu, Plus, Power, Trash2, FolderOpen, Package, RefreshCw, Download } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { adaptersApi } from "@/api/adapters";
import type { AdapterInfo } from "@/api/adapters";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { queryKeys } from "@/lib/queryKeys";
import { Button, Input, Badge, Card, Modal } from "@heroui/react";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { ChoosePathButton } from "@/components/PathInstructionsModal";
import { invalidateDynamicParser } from "@/adapters/dynamic-loader";
import { invalidateConfigSchemaCache } from "@/adapters/schema-config-fields";

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
            <Badge className="border border-border text-xs">{adapter.source === "external" ? "External" : "Built-in"}</Badge>
            {adapter.source === "external" && (
              adapter.isLocalPath
                ? <span title="Installed from local path"><FolderOpen className="h-4 w-4 text-amber-500" /></span>
                : <span title="Installed from npm"><Package className="h-4 w-4 text-red-500" /></span>
            )}
            {adapter.version && (
              <Badge className="font-mono text-[10px] bg-muted text-muted-foreground border-transparent">
                v{adapter.version}
              </Badge>
            )}
            {adapter.overriddenBuiltin && (
              <Badge className="text-blue-600 border-blue-400 bg-muted">
                Overrides built-in
              </Badge>
            )}
            {overriddenBy && (
              <Badge className="text-blue-600 border-blue-400 bg-muted">
                Overridden by {overriddenBy}
              </Badge>
            )}
            {adapter.disabled && (
              <Badge className="text-amber-600 border-amber-400 bg-muted">
                {disabledBadgeLabel ?? "Hidden from menus"}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {adapter.type}
            {adapter.packageName && adapter.packageName !== adapter.type && (
              <> · {adapter.packageName}</>
            )}
            {" · "}{adapter.modelsCount} models
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onReinstall && (
            <Button
              variant="outline"
              size="sm" isIconOnly
              className="h-8 w-8"
              aria-label="Reinstall adapter (pull latest from npm)"
              isDisabled={isReinstalling}
              onPress={() => onReinstall(adapter.type)}
            >
              <Download className={cn("h-4 w-4", isReinstalling && "animate-bounce")} />
            </Button>
          )}
          {onReload && (
            <Button
              variant="outline"
              size="sm" isIconOnly
              className="h-8 w-8"
              aria-label="Reload adapter (hot-swap)"
              isDisabled={isReloading}
              onPress={() => onReload(adapter.type)}
            >
              <RefreshCw className={cn("h-4 w-4", isReloading && "animate-spin")} />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm" isIconOnly
            className="h-8 w-8"
            aria-label={adapter.disabled
              ? (toggleTitleEnabled ?? "Show in agent menus")
              : (toggleTitleDisabled ?? "Hide from agent menus")}
            isDisabled={isToggling}
            onPress={() => onToggle(adapter.type, !adapter.disabled)}
          >
            <Power className={cn("h-4 w-4", !adapter.disabled ? "text-green-600" : "text-muted-foreground")} />
          </Button>
          {canRemove && (
            <Button
              variant="outline"
              size="sm" isIconOnly
              className="h-8 w-8 text-destructive hover:text-destructive"
              aria-label="Remove adapter"
              onPress={() => onRemove(adapter.type)}
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
    <Modal.Backdrop isOpen={open} onOpenChange={(isOpen: boolean) => { if (!isOpen) onCancel(); }}>
      <Modal.Container>
        <Modal.Dialog>
          <div className="p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold">Reinstall Adapter</h2>
              <p className="text-sm text-muted-foreground mt-1">
                This will pull the latest version of{" "}
                <strong>{adapter?.packageName}</strong> from npm and hot-swap
                the running adapter module. Existing agents will use the new
                version on their next run.
              </p>
            </div>

            <div className="rounded-md border bg-muted/50 px-4 py-3 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Package</span>
                <span className="font-mono">{adapter?.packageName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Current</span>
                <span className="font-mono">
                  {adapter?.version ? `v${adapter.version}` : "unknown"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Latest on npm</span>
                <span className="font-mono">
                  {isFetchingVersion
                    ? "checking..."
                    : latestVersion
                      ? `v${latestVersion}`
                      : "unavailable"}
                </span>
              </div>
              {isUpToDate && (
                <p className="text-xs text-muted-foreground pt-1">
                  Already on the latest version.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onPress={onCancel} isDisabled={isReinstalling}>
                Cancel
              </Button>
              <Button isDisabled={isReinstalling} onPress={onConfirm}>
                {isReinstalling ? "Reinstalling..." : "Reinstall"}
              </Button>
            </div>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function AdapterManager() {
  const { selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [installPackage, setInstallPackage] = useState("");
  const [installVersion, setInstallVersion] = useState("");
  const [isLocalPath, setIsLocalPath] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [removeType, setRemoveType] = useState<string | null>(null);
  const [reinstallTarget, setReinstallTarget] = useState<AdapterInfo | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/instance/settings/general" },
      { label: "Adapters" },
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
        title: "Adapter installed",
        body: `Type "${result.type}" registered successfully.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Install failed", body: err.message, tone: "error" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.remove(type),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Adapter removed", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Removal failed", body: err.message, tone: "error" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ type, disabled }: { type: string; disabled: boolean }) =>
      adaptersApi.setDisabled(type, disabled),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: "Toggle failed", body: err.message, tone: "error" });
    },
  });

  const overrideMutation = useMutation({
    mutationFn: ({ type, paused }: { type: string; paused: boolean }) =>
      adaptersApi.setOverridePaused(type, paused),
    onSuccess: () => {
      invalidate();
    },
    onError: (err: Error) => {
      pushToast({ title: "Override toggle failed", body: err.message, tone: "error" });
    },
  });

  const reloadMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reload(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: "Adapter reloaded",
        body: `Type "${result.type}" reloaded.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Reload failed", body: err.message, tone: "error" });
    },
  });

  const reinstallMutation = useMutation({
    mutationFn: (type: string) => adaptersApi.reinstall(type),
    onSuccess: (result) => {
      invalidate();
      invalidateDynamicParser(result.type);
      invalidateConfigSchemaCache(result.type);
      pushToast({
        title: "Adapter reinstalled",
        body: `Type "${result.type}" updated from npm.${result.version ? ` (v${result.version})` : ""}`,
        tone: "success",
      });
    },
    onError: (err: Error) => {
      pushToast({ title: "Reinstall failed", body: err.message, tone: "error" });
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

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading adapters...</div>;

  const isMutating = installMutation.isPending || removeMutation.isPending || toggleMutation.isPending || overrideMutation.isPending || reloadMutation.isPending || reinstallMutation.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Adapters</h1>
          <Badge className="text-amber-600 border border-amber-400">
            Alpha
          </Badge>
        </div>

        <Button size="sm" className="gap-2" onPress={() => setInstallDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          Install Adapter
        </Button>
        <Modal.Backdrop isOpen={installDialogOpen} onOpenChange={(isOpen: boolean) => setInstallDialogOpen(isOpen)}>
          <Modal.Container>
            <Modal.Dialog>
              <div className="p-6 space-y-4">
                <div>
                  <h2 className="text-base font-semibold">Install External Adapter</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Add an adapter from npm or a local path. The adapter package must export <code className="text-xs bg-muted px-1 py-0.5 rounded">createServerAdapter()</code>.
                  </p>
                </div>
                <div className="grid gap-4">
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
                      npm package
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
                      Local path
                    </button>
                  </div>

                  {isLocalPath ? (
                    /* Local path input */
                    <div className="grid gap-2">
                      <label htmlFor="adapterLocalPath" className="text-sm font-medium">Path to adapter package</label>
                      <div className="flex gap-2">
                        <Input
                          id="adapterLocalPath"
                          className="flex-1 font-mono text-xs"
                          placeholder="/mnt/e/Projects/my-adapter  or  E:\Projects\my-adapter"
                          value={installPackage}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInstallPackage(e.target.value)}
                        />
                        <ChoosePathButton />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Accepts Linux, WSL, and Windows paths. Windows paths are auto-converted.
                      </p>
                    </div>
                  ) : (
                    /* npm package input */
                    <>
                      <div className="grid gap-2">
                        <label htmlFor="adapterPackageName" className="text-sm font-medium">Package Name</label>
                        <Input
                          id="adapterPackageName"
                          placeholder="my-paperclip-adapter"
                          value={installPackage}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInstallPackage(e.target.value)}
                        />
                      </div>
                      <div className="grid gap-2">
                        <label htmlFor="adapterVersion" className="text-sm font-medium">Version (optional)</label>
                        <Input
                          id="adapterVersion"
                          placeholder="latest"
                          value={installVersion}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInstallVersion(e.target.value)}
                        />
                      </div>
                    </>
                  )}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onPress={() => setInstallDialogOpen(false)}>Cancel</Button>
                  <Button
                    onPress={() =>
                      installMutation.mutate({
                        packageName: installPackage,
                        version: installVersion || undefined,
                        isLocalPath,
                      })
                    }
                    isDisabled={!installPackage || installMutation.isPending}
                  >
                    {installMutation.isPending ? "Installing..." : "Install"}
                  </Button>
                </div>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </div>

      {/* Alpha notice */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">External adapters are alpha.</p>
            <p className="text-muted-foreground">
              The adapter plugin system is under active development. APIs and storage format may change.
              Use the power icon to hide adapters from agent menus without removing them.
            </p>
          </div>
        </div>
      </div>

      {/* External adapters */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-base font-semibold">External Adapters</h2>
        </div>

        {externalAdapters.length === 0 ? (
          <Card className="bg-muted/30">
            <Card.Content className="flex flex-col items-center justify-center py-10">
              <Cpu className="h-10 w-10 text-muted-foreground mb-4" />
              <p className="text-sm font-medium">No external adapters installed</p>
              <p className="text-xs text-muted-foreground mt-1">
                Install an adapter package to extend model support.
              </p>
            </Card.Content>
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
                  toggleTitleDisabled={isBuiltinOverride ? "Pause external override" : undefined}
                  toggleTitleEnabled={isBuiltinOverride ? "Resume external override" : undefined}
                  disabledBadgeLabel={isBuiltinOverride ? "Override paused" : undefined}
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
          <h2 className="text-base font-semibold">Built-in Adapters</h2>
        </div>

        {builtinAdapters.length === 0 && overriddenBuiltins.length === 0 ? (
          <div className="text-sm text-muted-foreground">No built-in adapters found.</div>
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
      <Modal.Backdrop
        isOpen={removeType !== null}
        onOpenChange={(isOpen: boolean) => { if (!isOpen) setRemoveType(null); }}
      >
        <Modal.Container>
          <Modal.Dialog>
            <div className="p-6 space-y-4">
              <div>
                <h2 className="text-base font-semibold">Remove Adapter</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Are you sure you want to remove the <strong>{removeType}</strong> adapter?
                  It will be unregistered and removed from the adapter store.
                  {removeType && adapters?.find((a) => a.type === removeType)?.packageName && (
                    <> npm packages will be cleaned up from disk.</>
                  )}
                  {" "}This action cannot be undone.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onPress={() => setRemoveType(null)}>Cancel</Button>
                <Button
                  variant="danger"
                  isDisabled={removeMutation.isPending}
                  onPress={() => {
                    if (removeType) {
                      removeMutation.mutate(removeType, {
                        onSettled: () => setRemoveType(null),
                      });
                    }
                  }}
                >
                  {removeMutation.isPending ? "Removing..." : "Remove"}
                </Button>
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
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
