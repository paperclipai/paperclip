import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Puzzle, ArrowLeft, ShieldAlert, ActivitySquare, CheckCircle, XCircle, Loader2, Clock, Cpu, Webhook, CalendarClock, AlertTriangle } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link, useParams } from "@/lib/router";
import { PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  JsonSchemaForm,
  validateJsonSchemaForm,
  getDefaultValues,
  type JsonSchemaNode,
} from "@/components/JsonSchemaForm";

/**
 * PluginSettings page component.
 *
 * Detailed settings and diagnostics page for a single installed plugin.
 * Navigated to from {@link PluginManager} via the Settings gear icon.
 *
 * Displays:
 * - Plugin identity: display name, id, version, description, categories.
 * - Manifest-declared capabilities (what data and features the plugin can access).
 * - Health check results (only for `ready` plugins; polled every 30 seconds).
 * - Runtime dashboard: worker status/uptime, recent job runs, webhook deliveries.
 * - Auto-generated config form from `instanceConfigSchema` (when no custom settings page).
 * - Plugin-contributed settings UI via `<PluginSlotOutlet type="settingsPage" />`.
 *
 * Data flow:
 * - `GET /api/plugins/:pluginId` — plugin record (refreshes on mount).
 * - `GET /api/plugins/:pluginId/health` — health diagnostics (polling).
 *   Only fetched when `plugin.status === "ready"`.
 * - `GET /api/plugins/:pluginId/dashboard` — aggregated runtime dashboard data (polling).
 * - `GET /api/plugins/:pluginId/config` — current config values.
 * - `POST /api/plugins/:pluginId/config` — save config values.
 * - `POST /api/plugins/:pluginId/config/test` — test connection.
 *
 * URL params:
 * - `companyPrefix` — the company slug (for breadcrumb links).
 * - `pluginId` — UUID of the plugin to display.
 *
 * @see PluginManager — parent list page.
 * @see doc/plugins/PLUGIN_SPEC.md §13 — Plugin Health Checks.
 * @see doc/plugins/PLUGIN_SPEC.md §19.8 — Plugin Settings UI.
 */
export function PluginSettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyPrefix, pluginId } = useParams<{ companyPrefix?: string; pluginId: string }>();
  const queryClient = useQueryClient();

  const { data: plugin, isLoading: pluginLoading } = useQuery({
    queryKey: queryKeys.plugins.detail(pluginId!),
    queryFn: () => pluginsApi.get(pluginId!),
    enabled: !!pluginId,
  });

  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: queryKeys.plugins.health(pluginId!),
    queryFn: () => pluginsApi.health(pluginId!),
    enabled: !!pluginId && plugin?.status === "ready",
    refetchInterval: 30000,
  });

  const { data: dashboardData } = useQuery({
    queryKey: queryKeys.plugins.dashboard(pluginId!),
    queryFn: () => pluginsApi.dashboard(pluginId!),
    enabled: !!pluginId,
    refetchInterval: 30000,
  });

  const { data: recentLogs } = useQuery({
    queryKey: queryKeys.plugins.logs(pluginId!),
    queryFn: () => pluginsApi.logs(pluginId!, { limit: 50 }),
    enabled: !!pluginId && plugin?.status === "ready",
    refetchInterval: 30000,
  });

  // Fetch existing config for the plugin
  const configSchema = plugin?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  const hasConfigSchema = configSchema && configSchema.properties && Object.keys(configSchema.properties).length > 0;

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: queryKeys.plugins.config(pluginId!),
    queryFn: () => pluginsApi.getConfig(pluginId!),
    enabled: !!pluginId && !!hasConfigSchema,
  });

  const { slots } = usePluginSlots({
    slotTypes: ["settingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  // Filter slots to only show settings pages for this specific plugin
  const pluginSlots = slots.filter((slot) => slot.pluginId === pluginId);

  // If the plugin has a custom settingsPage slot, prefer that over auto-generated form
  const hasCustomSettingsPage = pluginSlots.length > 0;

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/settings" },
      { label: "Plugins", href: "/settings/plugins" },
      { label: plugin?.manifestJson?.displayName ?? plugin?.packageName ?? "Plugin Details" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, companyPrefix, plugin]);

  if (pluginLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading plugin details...</div>;
  }

  if (!plugin) {
    return <div className="p-4 text-sm text-destructive">Plugin not found.</div>;
  }

  // When disabled by operator, backend uses status "error" + lastError "disabled_by_operator"
  const isDisabledByOperator =
    plugin.status === "error" && plugin.lastError?.startsWith("disabled_by_operator");
  const displayStatus = isDisabledByOperator ? "disabled" : plugin.status;
  const statusVariant =
    plugin.status === "ready"
      ? "default"
      : isDisabledByOperator
        ? "secondary"
        : plugin.status === "error"
          ? "destructive"
          : "secondary";

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Link to="/settings/plugins">
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <Puzzle className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-xl font-semibold">{plugin.manifestJson.displayName ?? plugin.packageName}</h1>
          <Badge variant={statusVariant} className="ml-2">
            {displayStatus}
          </Badge>
          <Badge variant="outline" className="ml-1">
            v{plugin.manifestJson.version ?? plugin.version}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">About</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-4">
              <p>{plugin.manifestJson.description || "No description provided."}</p>

              <div className="pt-4 border-t border-border/50">
                <h3 className="font-medium mb-2 flex items-center gap-1.5 text-muted-foreground">
                  <ShieldAlert className="h-4 w-4" />
                  Permissions
                </h3>
                {plugin.manifestJson.capabilities && plugin.manifestJson.capabilities.length > 0 ? (
                  <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                    {plugin.manifestJson.capabilities.map((cap: string) => (
                      <li key={cap}>{cap}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground italic">No special permissions requested.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Settings</CardTitle>
            </CardHeader>
            <CardContent>
              {hasCustomSettingsPage ? (
                /* Plugin declares a custom settingsPage slot — render that */
                <PluginSlotOutlet
                  slotTypes={["settingsPage"]}
                  context={{
                    companyId: selectedCompanyId,
                    companyPrefix: companyPrefix ?? null,
                  }}
                  className="space-y-3"
                  missingBehavior="placeholder"
                />
              ) : hasConfigSchema ? (
                /* Auto-generate form from instanceConfigSchema */
                <PluginConfigForm
                  pluginId={pluginId!}
                  schema={configSchema!}
                  initialValues={configData?.configJson}
                  isLoading={configLoading}
                  pluginStatus={plugin.status}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This plugin does not require configuration.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Runtime Dashboard — worker status, jobs, webhooks */}
          {dashboardData && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-1.5">
                  <Cpu className="h-4 w-4" />
                  Runtime Dashboard
                </CardTitle>
                <CardDescription>
                  Worker process, scheduled jobs, and webhook deliveries
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Worker Status */}
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                    Worker Process
                  </h3>
                  {dashboardData.worker ? (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Status</span>
                        <Badge variant={dashboardData.worker.status === "running" ? "default" : "secondary"}>
                          {dashboardData.worker.status}
                        </Badge>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">PID</span>
                        <span className="font-mono text-xs">{dashboardData.worker.pid ?? "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Uptime</span>
                        <span className="text-xs">{formatUptime(dashboardData.worker.uptime)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Pending RPCs</span>
                        <span className="text-xs">{dashboardData.worker.pendingRequests}</span>
                      </div>
                      {dashboardData.worker.totalCrashes > 0 && (
                        <>
                          <div className="flex justify-between col-span-2">
                            <span className="text-muted-foreground flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3 text-amber-500" />
                              Crashes
                            </span>
                            <span className="text-xs">
                              {dashboardData.worker.consecutiveCrashes} consecutive / {dashboardData.worker.totalCrashes} total
                            </span>
                          </div>
                          {dashboardData.worker.lastCrashAt && (
                            <div className="flex justify-between col-span-2">
                              <span className="text-muted-foreground">Last Crash</span>
                              <span className="text-xs">{formatTimestamp(dashboardData.worker.lastCrashAt)}</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No worker process registered.</p>
                  )}
                </div>

                <Separator />

                {/* Recent Job Runs */}
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                    Recent Job Runs
                  </h3>
                  {dashboardData.recentJobRuns.length > 0 ? (
                    <div className="space-y-2">
                      {dashboardData.recentJobRuns.map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between gap-2 text-sm py-1.5 px-2 rounded-md bg-muted/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <JobStatusDot status={run.status} />
                            <span className="font-mono text-xs truncate" title={run.jobKey ?? run.jobId}>
                              {run.jobKey ?? run.jobId.slice(0, 8)}
                            </span>
                            <Badge variant="outline" className="text-[10px] px-1 py-0">
                              {run.trigger}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                            {run.durationMs != null && (
                              <span>{formatDuration(run.durationMs)}</span>
                            )}
                            <span title={run.createdAt}>
                              {formatRelativeTime(run.createdAt)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No job runs recorded yet.</p>
                  )}
                </div>

                <Separator />

                {/* Recent Webhook Deliveries */}
                <div>
                  <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                    <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                    Recent Webhook Deliveries
                  </h3>
                  {dashboardData.recentWebhookDeliveries.length > 0 ? (
                    <div className="space-y-2">
                      {dashboardData.recentWebhookDeliveries.map((delivery) => (
                        <div
                          key={delivery.id}
                          className="flex items-center justify-between gap-2 text-sm py-1.5 px-2 rounded-md bg-muted/50"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <DeliveryStatusDot status={delivery.status} />
                            <span className="font-mono text-xs truncate" title={delivery.webhookKey}>
                              {delivery.webhookKey}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
                            {delivery.durationMs != null && (
                              <span>{formatDuration(delivery.durationMs)}</span>
                            )}
                            <span title={delivery.createdAt}>
                              {formatRelativeTime(delivery.createdAt)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">No webhook deliveries recorded yet.</p>
                  )}
                </div>

                {/* Last checked timestamp */}
                <div className="pt-2 border-t border-border/50 text-xs text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  Last checked: {new Date(dashboardData.checkedAt).toLocaleTimeString()}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Logs — queryable plugin log history (§26.1) */}
          {recentLogs && recentLogs.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-1.5">
                  <ActivitySquare className="h-4 w-4" />
                  Recent Logs
                </CardTitle>
                <CardDescription>Last {recentLogs.length} log entries</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-64 overflow-y-auto space-y-1 font-mono text-xs">
                  {recentLogs.map((entry) => (
                    <div
                      key={entry.id}
                      className={`flex gap-2 py-0.5 ${
                        entry.level === "error" ? "text-destructive" :
                        entry.level === "warn" ? "text-yellow-600 dark:text-yellow-400" :
                        entry.level === "debug" ? "text-muted-foreground/60" :
                        "text-muted-foreground"
                      }`}
                    >
                      <span className="shrink-0 text-muted-foreground/50">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                      <Badge variant="outline" className="h-4 text-[10px] px-1 shrink-0">{entry.level}</Badge>
                      <span className="truncate" title={entry.message}>{entry.message}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-1.5">
                <ActivitySquare className="h-4 w-4" />
                Health Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              {healthLoading ? (
                <p className="text-sm text-muted-foreground">Checking health...</p>
              ) : !healthData ? (
                <p className="text-sm text-muted-foreground">Health data unavailable. Ensure the plugin is enabled.</p>
              ) : (
                <div className="space-y-4 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Overall</span>
                    <Badge variant={healthData.healthy ? "default" : "destructive"}>
                      {healthData.status}
                    </Badge>
                  </div>

                  {healthData.checks && healthData.checks.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-border/50">
                      {healthData.checks.map((check, i) => (
                        <div key={i} className="flex items-start justify-between gap-2">
                          <span className="text-muted-foreground truncate" title={check.name}>
                            {check.name}
                          </span>
                          {check.passed ? (
                            <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                          ) : (
                            <XCircle className="h-4 w-4 text-destructive shrink-0" />
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {healthData.lastError && (
                    <div className="p-2 rounded bg-destructive/10 text-destructive text-xs break-words border border-destructive/20">
                      {healthData.lastError}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-3 text-muted-foreground">
              <div className="flex justify-between">
                <span>Plugin ID</span>
                <span className="font-mono text-xs">{plugin.id}</span>
              </div>
              <div className="flex justify-between">
                <span>NPM Package</span>
                <span className="truncate max-w-[150px]" title={plugin.packageName}>
                  {plugin.packageName}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PluginConfigForm — auto-generated form for instanceConfigSchema
// ---------------------------------------------------------------------------

interface PluginConfigFormProps {
  pluginId: string;
  schema: JsonSchemaNode;
  initialValues?: Record<string, unknown>;
  isLoading?: boolean;
  /** Current plugin lifecycle status — "Test Connection" only available when `ready`. */
  pluginStatus?: string;
}

/**
 * Inner component that manages form state, validation, save, and "Test Connection"
 * for the auto-generated plugin config form.
 *
 * Separated from PluginSettings to isolate re-render scope — only the form
 * re-renders on field changes, not the entire page.
 */
function PluginConfigForm({ pluginId, schema, initialValues, isLoading, pluginStatus }: PluginConfigFormProps) {
  const queryClient = useQueryClient();

  // Form values: start with saved values, fall back to schema defaults
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  }));

  // Sync when saved config loads asynchronously — only on first load so we
  // don't overwrite in-progress user edits if the query refetches (e.g. on
  // window focus).
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    if (initialValues && !hasHydratedRef.current) {
      hasHydratedRef.current = true;
      setValues({
        ...getDefaultValues(schema),
        ...initialValues,
      });
    }
  }, [initialValues, schema]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Dirty tracking: compare against initial values
  const isDirty = JSON.stringify(values) !== JSON.stringify({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.saveConfig(pluginId, configJson),
    onSuccess: () => {
      setSaveMessage({ type: "success", text: "Configuration saved." });
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config(pluginId) });
      // Clear success message after 3s
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message || "Failed to save configuration." });
    },
  });

  // Test connection mutation
  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.testConfig(pluginId, configJson),
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", text: "Connection test passed." });
      } else {
        setTestResult({ type: "error", text: result.message || "Connection test failed." });
      }
    },
    onError: (err: Error) => {
      setTestResult({ type: "error", text: err.message || "Connection test failed." });
    },
  });

  const handleChange = useCallback((newValues: Record<string, unknown>) => {
    setValues(newValues);
    // Clear field-level errors as the user types
    setErrors({});
    setSaveMessage(null);
  }, []);

  const handleSave = useCallback(() => {
    // Validate before saving
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    saveMutation.mutate(values);
  }, [schema, values, saveMutation]);

  const handleTestConnection = useCallback(() => {
    // Validate before testing
    const validationErrors = validateJsonSchemaForm(schema, values);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors({});
    setTestResult(null);
    testMutation.mutate(values);
  }, [schema, values, testMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading configuration...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <JsonSchemaForm
        schema={schema}
        values={values}
        onChange={handleChange}
        errors={errors}
        disabled={saveMutation.isPending}
      />

      {/* Status messages */}
      {saveMessage && (
        <div
          className={`text-sm p-2 rounded border ${
            saveMessage.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {saveMessage.text}
        </div>
      )}

      {testResult && (
        <div
          className={`text-sm p-2 rounded border ${
            testResult.type === "success"
              ? "text-green-700 bg-green-50 border-green-200 dark:text-green-400 dark:bg-green-950/30 dark:border-green-900"
              : "text-destructive bg-destructive/10 border-destructive/20"
          }`}
        >
          {testResult.text}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={handleSave}
          disabled={saveMutation.isPending || !isDirty}
          size="sm"
        >
          {saveMutation.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Configuration"
          )}
        </Button>
        {pluginStatus === "ready" && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard helper components and formatting utilities
// ---------------------------------------------------------------------------

/**
 * Format an uptime value (in milliseconds) to a human-readable string.
 */
function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs == null) return "—";
  const totalSeconds = Math.floor(uptimeMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Format a duration in milliseconds to a compact display string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format an ISO timestamp to a relative time string (e.g., "2m ago").
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a unix timestamp (ms since epoch) to a locale string.
 */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/**
 * Status indicator dot for job run statuses.
 */
function JobStatusDot({ status }: { status: string }) {
  const colorClass =
    status === "success" || status === "succeeded"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "running"
          ? "bg-blue-500 animate-pulse"
          : status === "cancelled"
            ? "bg-gray-400"
            : "bg-amber-500"; // queued, pending
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${colorClass}`}
      title={status}
    />
  );
}

/**
 * Status indicator dot for webhook delivery statuses.
 */
function DeliveryStatusDot({ status }: { status: string }) {
  const colorClass =
    status === "processed" || status === "success"
      ? "bg-green-500"
      : status === "failed"
        ? "bg-red-500"
        : status === "received"
          ? "bg-blue-500"
          : "bg-amber-500"; // pending
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${colorClass}`}
      title={status}
    />
  );
}
