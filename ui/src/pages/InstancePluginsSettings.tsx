import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Loader2,
  Package,
  Plug,
  RefreshCw,
  Save,
  Settings2,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import type { PluginConfigField, PluginConfigSchema, PluginRegistryRecord } from "@paperclipai/shared";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { formatDateTime, relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

function StatusBadge({ plugin }: { plugin: PluginRegistryRecord }) {
  if (!plugin.enabled) {
    return <Badge variant="outline">Disabled</Badge>;
  }
  if (plugin.status === "ready") {
    return <Badge variant="default">Ready</Badge>;
  }
  return <Badge variant="destructive">Error</Badge>;
}

function normalizeFormFromSchema(schema: PluginConfigSchema, current: Record<string, unknown>) {
  const result: Record<string, string | boolean> = {};
  for (const field of schema.fields) {
    const source = current[field.key] ?? field.defaultValue;
    if (field.type === "boolean") {
      result[field.key] = Boolean(source);
      continue;
    }
    if (field.type === "json") {
      result[field.key] = JSON.stringify(source ?? null, null, 2);
      continue;
    }
    result[field.key] = source == null ? "" : String(source);
  }
  return result;
}

function parseConfigFromForm(schema: PluginConfigSchema, formValues: Record<string, string | boolean>) {
  const payload: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const raw = formValues[field.key];

    if (field.type === "boolean") {
      payload[field.key] = Boolean(raw);
      continue;
    }

    const text = typeof raw === "string" ? raw : String(raw ?? "");

    if (field.required && text.trim().length === 0) {
      throw new Error(`Field '${field.key}' is required.`);
    }

    if (text.trim().length === 0) {
      payload[field.key] = "";
      continue;
    }

    if (field.type === "number") {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Field '${field.key}' must be a valid number.`);
      }
      payload[field.key] = parsed;
      continue;
    }

    if (field.type === "json") {
      try {
        payload[field.key] = JSON.parse(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Field '${field.key}' has invalid JSON: ${message}`);
      }
      continue;
    }

    payload[field.key] = text;
  }

  return payload;
}

export function InstancePluginsSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [localPath, setLocalPath] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | boolean>>({});
  const [restartAfterSave, setRestartAfterSave] = useState(true);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Plugins" }]);
  }, [setBreadcrumbs]);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.instance.plugins(),
    queryFn: () => pluginsApi.list(),
    refetchInterval: 15_000,
  });

  const plugins = pluginsQuery.data?.plugins ?? [];

  useEffect(() => {
    if (plugins.length === 0) {
      setSelectedPluginId(null);
      return;
    }

    if (!selectedPluginId || !plugins.some((plugin) => plugin.pluginId === selectedPluginId)) {
      setSelectedPluginId(plugins[0]?.pluginId ?? null);
    }
  }, [plugins, selectedPluginId]);

  const configQuery = useQuery({
    queryKey: ["instance", "plugin-config", selectedPluginId],
    queryFn: () => pluginsApi.describeConfig(selectedPluginId!),
    enabled: Boolean(selectedPluginId),
  });

  useEffect(() => {
    if (!configQuery.data) return;
    setFormValues(normalizeFormFromSchema(configQuery.data.schema, configQuery.data.config));
    setRestartAfterSave(configQuery.data.schema.restartRequired ?? true);
  }, [configQuery.data]);

  const installMutation = useMutation({
    mutationFn: async () => {
      const trimmed = localPath.trim();
      if (!trimmed) {
        throw new Error("Please provide a local plugin package path.");
      }
      return pluginsApi.installLocal(trimmed);
    },
    onSuccess: async (result) => {
      setErrorMessage(null);
      setLocalPath("");
      setSelectedPluginId(result.plugin.pluginId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.plugins() });
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Install failed");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ pluginId, enabled }: { pluginId: string; enabled: boolean }) =>
      pluginsApi.setEnabled(pluginId, enabled),
    onSuccess: async () => {
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.plugins() });
      await queryClient.invalidateQueries({ queryKey: ["instance", "plugin-config", selectedPluginId] });
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update plugin state");
    },
  });

  const restartMutation = useMutation({
    mutationFn: (pluginId: string) => pluginsApi.restart(pluginId),
    onSuccess: async () => {
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.plugins() });
      await queryClient.invalidateQueries({ queryKey: ["instance", "plugin-config", selectedPluginId] });
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Restart failed");
    },
  });

  const configSaveMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPluginId || !configQuery.data) {
        throw new Error("Please select a plugin first.");
      }
      const payload = parseConfigFromForm(configQuery.data.schema, formValues);
      return pluginsApi.updateConfig(selectedPluginId, payload, { restart: restartAfterSave });
    },
    onSuccess: async () => {
      setErrorMessage(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.plugins() });
      await queryClient.invalidateQueries({ queryKey: ["instance", "plugin-config", selectedPluginId] });
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : "Config save failed");
    },
  });

  const stats = useMemo(() => {
    const ready = plugins.filter((plugin) => plugin.status === "ready" && plugin.enabled).length;
    const disabled = plugins.filter((plugin) => !plugin.enabled).length;
    const errors = plugins.filter((plugin) => plugin.status === "error").length;
    return { total: plugins.length, ready, disabled, errors };
  }, [plugins]);

  const selectedPlugin = useMemo(
    () => plugins.find((plugin) => plugin.pluginId === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  );

  if (pluginsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading plugins...</div>;
  }

  if (pluginsQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {pluginsQuery.error instanceof Error
          ? pluginsQuery.error.message
          : "Failed to load plugin records."}
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Plugin Host</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage plugins installed in the current Paperclip instance.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="text-sm font-medium">Install plugin from local path</div>
          <div className="text-xs text-muted-foreground">
            Allowed location: <code>~/.paperclip/plugins/local/*</code>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="/Users/.../.paperclip/plugins/local/my-plugin"
              value={localPath}
              onChange={(event) => setLocalPath(event.target.value)}
              disabled={installMutation.isPending}
            />
            <Button
              onClick={() => installMutation.mutate()}
              disabled={installMutation.isPending || localPath.trim().length === 0}
              className="sm:w-auto"
            >
              {installMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Installing...
                </>
              ) : (
                <>
                  <Package className="mr-2 h-4 w-4" /> Install
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-4 text-sm text-muted-foreground">
        <span><span className="font-semibold text-foreground">{stats.total}</span> total</span>
        <span><span className="font-semibold text-foreground">{stats.ready}</span> ready</span>
        <span><span className="font-semibold text-foreground">{stats.disabled}</span> disabled</span>
        <span><span className="font-semibold text-foreground">{stats.errors}</span> errors</span>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {plugins.length === 0 ? (
        <EmptyState icon={Package} message="No plugins installed yet." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {plugins.map((plugin) => {
                  const toggling =
                    toggleMutation.isPending && toggleMutation.variables?.pluginId === plugin.pluginId;
                  const restarting =
                    restartMutation.isPending && restartMutation.variables === plugin.pluginId;
                  const selected = selectedPluginId === plugin.pluginId;

                  return (
                    <button
                      key={plugin.pluginId}
                      type="button"
                      className={`w-full px-3 py-3 text-left text-sm space-y-2 ${selected ? "bg-muted/40" : ""}`}
                      onClick={() => setSelectedPluginId(plugin.pluginId)}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge plugin={plugin} />
                        <span className="font-medium">{plugin.pluginId}</span>
                        <span className="text-muted-foreground">{plugin.packageVersion}</span>
                      </div>

                      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
                        <span className="truncate" title={plugin.sourcePath}>source: {plugin.sourcePath}</span>
                        <span title={formatDateTime(plugin.updatedAt)}>updated: {relativeTime(plugin.updatedAt)}</span>
                        <span>
                          lifecycle: load {plugin.lifecycle.loadCount}, restart {plugin.lifecycle.restartCount}
                        </span>
                        <span>
                          health: {plugin.lastHealth ? "available" : "n/a"}
                        </span>
                        {plugin.lastError && (
                          <span className="text-destructive truncate" title={plugin.lastError}>
                            error: {plugin.lastError}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={toggling}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleMutation.mutate({
                              pluginId: plugin.pluginId,
                              enabled: !plugin.enabled,
                            });
                          }}
                        >
                          {plugin.enabled ? (
                            <>
                              <ToggleLeft className="mr-1.5 h-4 w-4" /> Disable
                            </>
                          ) : (
                            <>
                              <ToggleRight className="mr-1.5 h-4 w-4" /> Enable
                            </>
                          )}
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          disabled={restarting}
                          onClick={(event) => {
                            event.stopPropagation();
                            restartMutation.mutate(plugin.pluginId);
                          }}
                        >
                          {restarting ? (
                            <>
                              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Restarting...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="mr-1.5 h-4 w-4" /> Restart
                            </>
                          )}
                        </Button>

                        <span className="text-xs text-muted-foreground inline-flex items-center">
                          <Activity className="mr-1 h-3.5 w-3.5" /> health/status shown from registry snapshot
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-4">
              <div className="flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">Plugin configuration</div>
              </div>

              {!selectedPlugin ? (
                <div className="text-sm text-muted-foreground">Select a plugin to configure.</div>
              ) : configQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading config schema...</div>
              ) : configQuery.error ? (
                <div className="text-sm text-destructive">
                  {configQuery.error instanceof Error ? configQuery.error.message : "Failed to load config"}
                </div>
              ) : configQuery.data ? (
                <>
                  <div className="space-y-1">
                    <div className="text-sm font-semibold">{selectedPlugin.pluginId}</div>
                    <div className="text-xs text-muted-foreground">
                      source: {configQuery.data.schemaSource} · schema fields: {configQuery.data.schema.fields.length}
                    </div>
                    {configQuery.data.schema.description && (
                      <div className="text-xs text-muted-foreground">{configQuery.data.schema.description}</div>
                    )}
                  </div>

                  <div className="space-y-3">
                    {configQuery.data.schema.fields.map((field) => {
                      const value = formValues[field.key];
                      const label = field.label ?? field.key;

                      if (field.type === "boolean") {
                        return (
                          <div key={field.key} className="flex items-center justify-between gap-3 rounded border p-2">
                            <div className="space-y-0.5">
                              <Label htmlFor={`cfg-${field.key}`}>{label}</Label>
                              {field.description && (
                                <div className="text-xs text-muted-foreground">{field.description}</div>
                              )}
                            </div>
                            <Checkbox
                              id={`cfg-${field.key}`}
                              checked={Boolean(value)}
                              onCheckedChange={(checked) =>
                                setFormValues((prev) => ({ ...prev, [field.key]: Boolean(checked) }))
                              }
                            />
                          </div>
                        );
                      }

                      if (field.type === "select") {
                        const options = field.options ?? [];
                        return (
                          <div key={field.key} className="space-y-1.5">
                            <Label htmlFor={`cfg-${field.key}`}>{label}</Label>
                            {field.description && (
                              <div className="text-xs text-muted-foreground">{field.description}</div>
                            )}
                            <Select
                              value={String(value ?? "")}
                              onValueChange={(next) =>
                                setFormValues((prev) => ({ ...prev, [field.key]: next }))
                              }
                            >
                              <SelectTrigger id={`cfg-${field.key}`}>
                                <SelectValue placeholder={field.placeholder ?? "Select value"} />
                              </SelectTrigger>
                              <SelectContent>
                                {options.map((option) => (
                                  <SelectItem key={`${field.key}-${String(option.value)}`} value={String(option.value)}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        );
                      }

                      const isTextarea = field.type === "textarea" || field.type === "json";
                      const isPassword = field.type === "password" || field.secret;

                      return (
                        <div key={field.key} className="space-y-1.5">
                          <Label htmlFor={`cfg-${field.key}`}>{label}</Label>
                          {field.description && (
                            <div className="text-xs text-muted-foreground">{field.description}</div>
                          )}
                          {isTextarea ? (
                            <Textarea
                              id={`cfg-${field.key}`}
                              value={String(value ?? "")}
                              placeholder={field.placeholder}
                              rows={field.type === "json" ? 6 : 3}
                              className="font-mono text-xs"
                              onChange={(event) =>
                                setFormValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                              }
                            />
                          ) : (
                            <Input
                              id={`cfg-${field.key}`}
                              type={isPassword ? "password" : field.type === "number" ? "number" : "text"}
                              value={String(value ?? "")}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                setFormValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="restart-after-save"
                      checked={restartAfterSave}
                      onCheckedChange={(checked) => setRestartAfterSave(Boolean(checked))}
                    />
                    <Label htmlFor="restart-after-save" className="text-xs text-muted-foreground">
                      Restart plugin after save {configQuery.data.schema.restartRequired ? "(recommended by schema)" : "(optional)"}
                    </Label>
                  </div>

                  <Button
                    onClick={() => configSaveMutation.mutate()}
                    disabled={configSaveMutation.isPending}
                    className="w-full"
                  >
                    {configSaveMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" /> Save config
                      </>
                    )}
                  </Button>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
