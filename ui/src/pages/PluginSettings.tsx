import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Puzzle, ArrowLeft, ShieldAlert, ActivitySquare, CheckCircle, XCircle, Loader2, Clock, Cpu, Webhook, CalendarClock, AlertTriangle } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useLocale } from "@/context/LocaleContext";
import { Link, Navigate, useParams } from "@/lib/router";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import {
  formatInstanceAdminDuration,
  formatInstanceAdminJobTriggerLabel,
  formatInstanceAdminRelativeTime,
  formatInstanceAdminStatusLabel,
  formatInstanceAdminUptime,
  formatPluginCrashSummary,
  formatPluginLogEntryCount,
  getInstanceAdminCopy,
} from "@/lib/instance-admin-copy";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { formatDateTime, formatTime } from "@/lib/utils";
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
 * - `POST /api/plugins/:pluginId/config/test` — test configuration.
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
  const { locale } = useLocale();
  const copy = getInstanceAdminCopy(locale);
  const { companyPrefix, pluginId } = useParams<{ companyPrefix?: string; pluginId: string }>();
  const [activeTab, setActiveTab] = useState<"configuration" | "status">("configuration");

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
      { label: selectedCompany?.name ?? copy.company, href: "/dashboard" },
      { label: copy.plugins.breadcrumbSettings, href: "/instance/settings/heartbeats" },
      { label: copy.plugins.breadcrumbPlugins, href: "/instance/settings/plugins" },
      { label: plugin?.manifestJson?.displayName ?? plugin?.packageName ?? copy.plugins.pluginDetailsFallback },
    ]);
  }, [
    companyPrefix,
    copy.company,
    copy.plugins.breadcrumbPlugins,
    copy.plugins.breadcrumbSettings,
    copy.plugins.pluginDetailsFallback,
    plugin,
    selectedCompany?.name,
    setBreadcrumbs,
  ]);

  useEffect(() => {
    setActiveTab("configuration");
  }, [pluginId]);

  if (pluginLoading) {
    return <div className="p-4 text-sm text-muted-foreground">{copy.plugins.loadingPluginDetails}</div>;
  }

  if (!plugin) {
    return <Navigate to="/instance/settings/plugins" replace />;
  }

  const displayStatus = formatInstanceAdminStatusLabel(plugin.status, locale);
  const statusVariant =
    plugin.status === "ready"
      ? "default"
      : plugin.status === "error"
        ? "destructive"
        : "secondary";
  const pluginDescription = plugin.manifestJson.description || copy.plugins.noDescriptionProvided;
  const pluginCapabilities = plugin.manifestJson.capabilities ?? [];

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-4">
        <Link to="/instance/settings/plugins">
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

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as "configuration" | "status")} className="space-y-6">
        <PageTabBar
          align="start"
          items={[
            { value: "configuration", label: copy.plugins.configurationTab },
            { value: "status", label: copy.plugins.statusTab },
          ]}
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "configuration" | "status")}
        />

        <TabsContent value="configuration" className="space-y-6">
          <div className="space-y-8">
            <section className="space-y-5">
              <h2 className="text-base font-semibold">{copy.plugins.about}</h2>
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.8fr)]">
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">{copy.plugins.description}</h3>
                  <p className="text-sm leading-6 text-foreground/90">{pluginDescription}</p>
                </div>
                <div className="space-y-4 text-sm">
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-muted-foreground">{copy.plugins.author}</h3>
                    <p className="text-foreground">{plugin.manifestJson.author}</p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-medium text-muted-foreground">{copy.plugins.categories}</h3>
                    <div className="flex flex-wrap gap-2">
                      {plugin.categories.length > 0 ? (
                        plugin.categories.map((category) => (
                          <Badge key={category} variant="outline" className="capitalize">
                            {category}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-foreground">{copy.plugins.none}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{copy.plugins.settings}</h2>
              </div>
              {hasCustomSettingsPage ? (
                <div className="space-y-3">
                  {pluginSlots.map((slot) => (
                    <PluginSlotMount
                      key={`${slot.pluginKey}:${slot.id}`}
                      slot={slot}
                      context={{
                        companyId: selectedCompanyId,
                        companyPrefix: companyPrefix ?? null,
                      }}
                      missingBehavior="placeholder"
                    />
                  ))}
                </div>
              ) : hasConfigSchema ? (
                <PluginConfigForm
                  pluginId={pluginId!}
                  schema={configSchema!}
                  initialValues={configData?.configJson}
                  isLoading={configLoading}
                  pluginStatus={plugin.status}
                  supportsConfigTest={(plugin as unknown as { supportsConfigTest?: boolean }).supportsConfigTest === true}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {copy.plugins.noSettingsRequired}
                </p>
              )}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="status" className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_320px]">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <Cpu className="h-4 w-4" />
                    {copy.plugins.runtimeDashboard}
                  </CardTitle>
                  <CardDescription>
                    {copy.plugins.runtimeDashboardDescription}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {dashboardData ? (
                    <>
                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                          {copy.plugins.workerProcess}
                        </h3>
                        {dashboardData.worker ? (
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{copy.plugins.status}</span>
                              <Badge variant={dashboardData.worker.status === "running" ? "default" : "secondary"}>
                                {formatInstanceAdminStatusLabel(dashboardData.worker.status, locale)}
                              </Badge>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{copy.plugins.pid}</span>
                              <span className="font-mono text-xs">{dashboardData.worker.pid ?? "—"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{copy.plugins.uptime}</span>
                              <span className="text-xs">{formatInstanceAdminUptime(dashboardData.worker.uptime, locale)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{copy.plugins.pendingRpcs}</span>
                              <span className="text-xs">{dashboardData.worker.pendingRequests}</span>
                            </div>
                            {dashboardData.worker.totalCrashes > 0 && (
                              <>
                                <div className="flex justify-between col-span-2">
                                  <span className="text-muted-foreground flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                                    {copy.plugins.crashes}
                                  </span>
                                  <span className="text-xs">
                                    {formatPluginCrashSummary(
                                      dashboardData.worker.consecutiveCrashes,
                                      dashboardData.worker.totalCrashes,
                                      locale,
                                    )}
                                  </span>
                                </div>
                                {dashboardData.worker.lastCrashAt && (
                                  <div className="flex justify-between col-span-2">
                                    <span className="text-muted-foreground">{copy.plugins.lastCrash}</span>
                                    <span className="text-xs">{formatTimestamp(dashboardData.worker.lastCrashAt)}</span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{copy.plugins.noWorkerProcess}</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
                          {copy.plugins.recentJobRuns}
                        </h3>
                        {dashboardData.recentJobRuns.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentJobRuns.map((run) => (
                              <div
                                key={run.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <JobStatusDot status={run.status} locale={locale} />
                                  <span className="truncate font-mono text-xs" title={run.jobKey ?? run.jobId}>
                                    {run.jobKey ?? run.jobId.slice(0, 8)}
                                  </span>
                                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                    {formatInstanceAdminJobTriggerLabel(run.trigger, locale)}
                                  </Badge>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {run.durationMs != null ? <span>{formatInstanceAdminDuration(run.durationMs, locale)}</span> : null}
                                  <span title={run.createdAt}>{formatInstanceAdminRelativeTime(run.createdAt, locale)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{copy.plugins.noJobRuns}</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                          {copy.plugins.recentWebhookDeliveries}
                        </h3>
                        {dashboardData.recentWebhookDeliveries.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentWebhookDeliveries.map((delivery) => (
                              <div
                                key={delivery.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <DeliveryStatusDot status={delivery.status} locale={locale} />
                                  <span className="truncate font-mono text-xs" title={delivery.webhookKey}>
                                    {delivery.webhookKey}
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {delivery.durationMs != null ? <span>{formatInstanceAdminDuration(delivery.durationMs, locale)}</span> : null}
                                  <span title={delivery.createdAt}>{formatInstanceAdminRelativeTime(delivery.createdAt, locale)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{copy.plugins.noWebhookDeliveries}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {copy.plugins.lastChecked}: {formatTime(dashboardData.checkedAt)}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {copy.plugins.runtimeUnavailable}
                    </p>
                  )}
                </CardContent>
              </Card>

              {recentLogs && recentLogs.length > 0 ? (
                <Card>
                  <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ActivitySquare className="h-4 w-4" />
                    {copy.plugins.recentLogs}
                  </CardTitle>
                    <CardDescription>{formatPluginLogEntryCount(recentLogs.length, locale)}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
                      {recentLogs.map((entry) => (
                        <div
                          key={entry.id}
                          className={`flex gap-2 py-0.5 ${
                            entry.level === "error"
                              ? "text-destructive"
                              : entry.level === "warn"
                                ? "text-yellow-600 dark:text-yellow-400"
                                : entry.level === "debug"
                                  ? "text-muted-foreground/60"
                                  : "text-muted-foreground"
                          }`}
                        >
                          <span className="shrink-0 text-muted-foreground/50">{formatTime(entry.createdAt)}</span>
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[10px]">
                            {formatInstanceAdminStatusLabel(entry.level, locale)}
                          </Badge>
                          <span className="truncate" title={entry.message}>{entry.message}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ActivitySquare className="h-4 w-4" />
                    {copy.plugins.healthStatus}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {healthLoading ? (
                    <p className="text-sm text-muted-foreground">{copy.plugins.checkingHealth}</p>
                  ) : healthData ? (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{copy.plugins.overall}</span>
                        <Badge variant={healthData.healthy ? "default" : "destructive"}>
                          {formatInstanceAdminStatusLabel(healthData.status, locale)}
                        </Badge>
                      </div>

                      {healthData.checks.length > 0 ? (
                        <div className="space-y-2 border-t border-border/50 pt-2">
                          {healthData.checks.map((check, i) => (
                            <div key={i} className="flex items-start justify-between gap-2">
                              <span className="truncate text-muted-foreground" title={check.name}>
                                {check.name}
                              </span>
                              {check.passed ? (
                                <CheckCircle className="h-4 w-4 shrink-0 text-green-500" />
                              ) : (
                                <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                              )}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {healthData.lastError ? (
                        <div className="break-words rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                          {healthData.lastError}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-3 text-sm text-muted-foreground">
                      <div className="flex items-center justify-between">
                        <span>{copy.plugins.lifecycle}</span>
                        <Badge variant={statusVariant}>{displayStatus}</Badge>
                      </div>
                      <p>{copy.plugins.healthChecksWhenReady}</p>
                      {plugin.lastError ? (
                        <div className="break-words rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive">
                          {plugin.lastError}
                        </div>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{copy.plugins.details}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <span>{copy.plugins.pluginId}</span>
                    <span className="font-mono text-xs text-right">{plugin.id}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{copy.plugins.pluginKey}</span>
                    <span className="font-mono text-xs text-right">{plugin.pluginKey}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{copy.plugins.npmPackage}</span>
                    <span className="max-w-[170px] truncate text-right text-xs" title={plugin.packageName}>
                      {plugin.packageName}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{copy.plugins.version}</span>
                    <span className="text-right text-foreground">v{plugin.manifestJson.version ?? plugin.version}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" />
                    {copy.plugins.permissions}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {pluginCapabilities.length > 0 ? (
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      {pluginCapabilities.map((cap) => (
                        <li key={cap} className="rounded-md bg-muted/40 px-2.5 py-2 font-mono text-xs text-foreground/85">
                          {cap}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">{copy.plugins.noSpecialPermissions}</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>
      </Tabs>
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
  /** Current plugin lifecycle status — "Test Configuration" only available when `ready`. */
  pluginStatus?: string;
  /** Whether the plugin worker implements `validateConfig`. */
  supportsConfigTest?: boolean;
}

/**
 * Inner component that manages form state, validation, save, and "Test Configuration"
 * for the auto-generated plugin config form.
 *
 * Separated from PluginSettings to isolate re-render scope — only the form
 * re-renders on field changes, not the entire page.
 */
function PluginConfigForm({ pluginId, schema, initialValues, isLoading, pluginStatus, supportsConfigTest }: PluginConfigFormProps) {
  const queryClient = useQueryClient();
  const { locale } = useLocale();
  const copy = getInstanceAdminCopy(locale);

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
      setSaveMessage({ type: "success", text: copy.plugins.configurationSaved });
      setTestResult(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config(pluginId) });
      // Clear success message after 3s
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message || copy.plugins.configurationSaveFailed });
    },
  });

  // Test configuration mutation
  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) =>
      pluginsApi.testConfig(pluginId, configJson),
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", text: copy.plugins.configurationTestPassed });
      } else {
        setTestResult({ type: "error", text: result.message || copy.plugins.configurationTestFailed });
      }
    },
    onError: (err: Error) => {
      setTestResult({ type: "error", text: err.message || copy.plugins.configurationTestFailed });
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
        {copy.plugins.loadingConfiguration}
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
              {copy.plugins.savingConfiguration}
            </>
          ) : (
            copy.plugins.saveConfiguration
          )}
        </Button>
        {pluginStatus === "ready" && supportsConfigTest && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {copy.plugins.testingConfiguration}
              </>
            ) : (
              copy.plugins.testConfiguration
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
function formatTimestamp(epochMs: number): string {
  return formatDateTime(epochMs);
}

/**
 * Status indicator dot for job run statuses.
 */
function JobStatusDot({ status, locale }: { status: string; locale: string | null | undefined }) {
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
      title={formatInstanceAdminStatusLabel(status, locale)}
    />
  );
}

/**
 * Status indicator dot for webhook delivery statuses.
 */
function DeliveryStatusDot({ status, locale }: { status: string; locale: string | null | undefined }) {
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
      title={formatInstanceAdminStatusLabel(status, locale)}
    />
  );
}
