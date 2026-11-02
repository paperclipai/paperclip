import { i18n, t, useTranslation } from "@/i18n";
import { pluginJobTriggerLabel, pluginStatusLabel } from "@/lib/plugin-display";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Puzzle, ArrowLeft, ShieldAlert, ActivitySquare, CheckCircle, XCircle, Loader2, Clock, Cpu, Webhook, CalendarClock, AlertTriangle, FolderOpen, Save } from "lucide-react";
import type { PluginLocalFolderDeclaration } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useManagedSandboxOnly } from "@/hooks/useManagedSandboxOnly";
import { Link, Navigate, useParams } from "@/lib/router";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { pluginsApi, type PluginLocalFolderStatus } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChoosePathButton } from "@/components/PathInstructionsModal";
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
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { companyPrefix, pluginId } = useParams<{ companyPrefix?: string; pluginId: string }>();
  const { hideHostPaths } = useManagedSandboxOnly();
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

  const configQueryKey = pluginId && selectedCompanyId
    ? queryKeys.plugins.config(pluginId, selectedCompanyId)
    : ["plugins", pluginId ?? "__missing_plugin__", "companies", "__missing_company__", "config"] as const;

  const { data: configData, isLoading: configLoading } = useQuery({
    queryKey: configQueryKey,
    queryFn: () => pluginsApi.getConfig(pluginId!, selectedCompanyId!),
    enabled: !!pluginId && !!hasConfigSchema && !!selectedCompanyId,
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
      { label: selectedCompany?.name ?? t("localizationPlugins.organization"), href: "/dashboard" },
      { get ["label"]() { return t("localizationPlugins.ui_Settings"); }, href: "/company/settings" },
      { get ["label"]() { return t("localizationPlugins.ui_Plugins"); }, href: "/company/settings/instance/plugins" },
      { label: plugin?.manifestJson?.displayName ?? plugin?.packageName ?? t("localizationPlugins.pluginDetails") },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, companyPrefix, plugin, t]);

  useEffect(() => {
    setActiveTab("configuration");
  }, [pluginId]);

  if (pluginLoading) {
    return <div className="p-4 text-sm text-muted-foreground">{t("localizationPlugins.ui_Loading_plugin_details_")}</div>;
  }

  if (!plugin) {
    return <Navigate to="/company/settings/instance/plugins" replace />;
  }

  const displayStatus = pluginStatusLabel(plugin.status);
  const statusVariant =
    plugin.status === "ready"
      ? "default"
      : plugin.status === "error"
        ? "destructive"
        : "secondary";
  const pluginDescription = plugin.manifestJson.description || t("localizationPlugins.noDescription");
  const pluginCapabilities = plugin.manifestJson.capabilities ?? [];
  const environmentDrivers = plugin.manifestJson.environmentDrivers ?? [];
  const localFolderDeclarations = plugin.manifestJson.localFolders ?? [];
  // A plugin local folder is an absolute path on the execution host. Under the
  // managed-sandbox-only policy the platform-managed environment owns the
  // filesystem, so the whole section disappears and the Settings tab falls back
  // to whatever else the plugin declares. The section also stays hidden until
  // the policy is known.
  const hasLocalFolders = localFolderDeclarations.length > 0 && !hideHostPaths;
  const environmentDriverNames = environmentDrivers
    .map((driver) => driver.displayName?.trim() || driver.driverKey)
    .filter((name, index, values) => values.indexOf(name) === index);
  const driverLabel = environmentDriverNames.join(", ");

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/company/settings/instance/plugins">
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
            { value: "configuration", get ["label"]() { return t("localizationPlugins.ui_Configuration"); } },
            { value: "status", get ["label"]() { return t("localizationPlugins.ui_Status"); } },
          ]}
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as "configuration" | "status")}
        />

        <TabsContent value="configuration" className="space-y-6">
          <div className="space-y-8">
            <section className="space-y-5">
              <h2 className="text-base font-semibold">{t("localizationPlugins.ui_About")}</h2>
              <div className="grid gap-8 lg:grid-cols-(--gtc-52)">
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">{t("localizationPlugins.ui_Description")}</h3>
                  <p className="text-sm leading-6 text-foreground/90">{pluginDescription}</p>
                </div>
                <div className="space-y-4 text-sm">
                  <div className="space-y-1.5">
                    <h3 className="font-medium text-muted-foreground">{t("localizationPlugins.ui_Author")}</h3>
                    <p className="text-foreground">{plugin.manifestJson.author}</p>
                  </div>
                  <div className="space-y-2">
                    <h3 className="font-medium text-muted-foreground">{t("localizationSkills.categories83")}</h3>
                    <div className="flex flex-wrap gap-2">
                      {plugin.categories.length > 0 ? (
                        plugin.categories.map((category) => (
                          <Badge key={category} variant="outline" className="capitalize">
                            {category}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-foreground">{t("localizationPlugins.ui_None")}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{t("localizationPlugins.ui_Settings")}</h2>
              </div>
              {hasLocalFolders ? (
                <PluginLocalFoldersSettings
                  pluginId={pluginId!}
                  companyId={selectedCompanyId}
                  declarations={localFolderDeclarations}
                />
              ) : null}
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
                  companyId={selectedCompanyId}
                  schema={configSchema!}
                  initialValues={configData?.configJson}
                  isLoading={configLoading}
                  pluginStatus={plugin.status}
                  supportsConfigTest={(plugin as unknown as { supportsConfigTest?: boolean }).supportsConfigTest === true}
                />
              ) : environmentDrivers.length > 0 ? (
                <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">{t("localizationPlugins.ui_Configure_this_plugin_from_Settings_Environments_")}</p>
                  <p className="mt-1 text-muted-foreground">
                    {t("localizationPlugins.environmentSettingsExplanation", { plugin: driverLabel || t("localizationPlugins.thisPlugin") })}
                  </p>
                  <div className="mt-3">
                    <Link to="/company/settings/instance/environments">
                      <Button variant="outline" size="sm">{t("localizationPlugins.ui_Open_Environments")}</Button>
                    </Link>
                  </div>
                </div>
              ) : !hasLocalFolders ? (
                <p className="text-sm text-muted-foreground">{t("localizationPlugins.ui_This_plugin_does_not_require_any_settings_")}</p>
              ) : null}
            </section>
          </div>
        </TabsContent>

        <TabsContent value="status" className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-(--gtc-39)">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <Cpu className="h-4 w-4" />{t("localizationPlugins.ui_Runtime_Dashboard")}</CardTitle>
                  <CardDescription>{t("localizationPlugins.ui_Worker_process_scheduled_jobs_and_webhook_deliveries")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {dashboardData ? (
                    <>
                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5 text-muted-foreground" />{t("localizationPlugins.ui_Worker_Process")}</h3>
                        {dashboardData.worker ? (
                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{t("localizationPlugins.ui_Status")}</span>
                              <Badge variant={dashboardData.worker.status === "running" ? "default" : "secondary"}>
                                {pluginStatusLabel(dashboardData.worker.status)}
                              </Badge>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">PID</span>
                              <span className="font-mono text-xs">{dashboardData.worker.pid ?? "—"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{t("localizationPlugins.ui_Uptime")}</span>
                              <span className="text-xs">{formatUptime(dashboardData.worker.uptime)}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">{t("localizationPlugins.ui_Pending_RPCs")}</span>
                              <span className="text-xs">{dashboardData.worker.pendingRequests}</span>
                            </div>
                            {dashboardData.worker.totalCrashes > 0 && (
                              <>
                                <div className="flex justify-between col-span-2">
                                  <span className="text-muted-foreground flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3 text-amber-500" />{t("localizationPlugins.ui_Crashes")}</span>
                                  <span className="text-xs">
                                    {t("localizationPlugins.crashCounts", { consecutive: dashboardData.worker.consecutiveCrashes, total: dashboardData.worker.totalCrashes })}
                                  </span>
                                </div>
                                {dashboardData.worker.lastCrashAt && (
                                  <div className="flex justify-between col-span-2">
                                    <span className="text-muted-foreground">{t("localizationPlugins.ui_Last_Crash")}</span>
                                    <span className="text-xs">{formatTimestamp(dashboardData.worker.lastCrashAt)}</span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{t("localizationPlugins.ui_No_worker_process_registered_")}</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />{t("localizationPlugins.ui_Recent_Job_Runs")}</h3>
                        {dashboardData.recentJobRuns.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentJobRuns.map((run) => (
                              <div
                                key={run.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <JobStatusDot status={run.status} />
                                  <span className="truncate font-mono text-xs" title={run.jobKey ?? run.jobId}>
                                    {run.jobKey ?? run.jobId.slice(0, 8)}
                                  </span>
                                  <Badge variant="outline" className="px-1 py-0 text-(length:--text-nano)">
                                    {pluginJobTriggerLabel(run.trigger)}
                                  </Badge>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {run.durationMs != null ? <span>{formatDuration(run.durationMs)}</span> : null}
                                  <span title={run.createdAt}>{formatRelativeTime(run.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{t("localizationPlugins.ui_No_job_runs_recorded_yet_")}</p>
                        )}
                      </div>

                      <Separator />

                      <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-1.5">
                          <Webhook className="h-3.5 w-3.5 text-muted-foreground" />{t("localizationPlugins.ui_Recent_Webhook_Deliveries")}</h3>
                        {dashboardData.recentWebhookDeliveries.length > 0 ? (
                          <div className="space-y-2">
                            {dashboardData.recentWebhookDeliveries.map((delivery) => (
                              <div
                                key={delivery.id}
                                className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <DeliveryStatusDot status={delivery.status} />
                                  <span className="truncate font-mono text-xs" title={delivery.webhookKey}>
                                    {delivery.webhookKey}
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                  {delivery.durationMs != null ? <span>{formatDuration(delivery.durationMs)}</span> : null}
                                  <span title={delivery.createdAt}>{formatRelativeTime(delivery.createdAt)}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground italic">{t("localizationPlugins.ui_No_webhook_deliveries_recorded_yet_")}</p>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 border-t border-border/50 pt-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {t("localizationPlugins.lastChecked", { time: new Date(dashboardData.checkedAt).toLocaleTimeString(i18n.resolvedLanguage) })}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t("localizationPlugins.ui_Runtime_diagnostics_are_unavailable_right_now_")}</p>
                  )}
                </CardContent>
              </Card>

              {recentLogs && recentLogs.length > 0 ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-1.5">
                      <ActivitySquare className="h-4 w-4" />{t("localizationPlugins.ui_Recent_Logs")}</CardTitle>
                    <CardDescription>{t("localizationPlugins.recentLogCount", { count: recentLogs.length })}</CardDescription>
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
                          <span className="shrink-0 text-muted-foreground/50">{new Date(entry.createdAt).toLocaleTimeString(i18n.resolvedLanguage)}</span>
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-(length:--text-nano)">{entry.level}</Badge>
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
                    <ActivitySquare className="h-4 w-4" />{t("localizationPlugins.ui_Health_Status")}</CardTitle>
                </CardHeader>
                <CardContent>
                  {healthLoading ? (
                    <p className="text-sm text-muted-foreground">{t("localizationPlugins.ui_Checking_health_")}</p>
                  ) : healthData ? (
                    <div className="space-y-4 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{t("localizationPlugins.ui_Overall")}</span>
                        <Badge variant={healthData.healthy ? "default" : "destructive"}>
                          {pluginStatusLabel(healthData.status)}
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
                        <span>{t("localizationPlugins.ui_Lifecycle")}</span>
                        <Badge variant={statusVariant}>{displayStatus}</Badge>
                      </div>
                      <p>{t("localizationPlugins.ui_Health_checks_run_once_the_plugin_is_ready_")}</p>
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
                  <CardTitle className="text-base">{t("localizationPlugins.ui_Details")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <div className="flex justify-between gap-3">
                    <span>{t("localizationPlugins.ui_Plugin_ID")}</span>
                    <span className="font-mono text-xs text-right">{plugin.id}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{t("localizationPlugins.ui_Plugin_Key")}</span>
                    <span className="font-mono text-xs text-right">{plugin.pluginKey}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{t("localizationPlugins.ui_NPM_Package")}</span>
                    <span className="max-w-(--sz-170px) truncate text-right text-xs" title={plugin.packageName}>
                      {plugin.packageName}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span>{t("localizationSkills.version189")}</span>
                    <span className="text-right text-foreground">v{plugin.manifestJson.version ?? plugin.version}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" />{t("localizationPlugins.ui_Permissions")}</CardTitle>
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
                    <p className="text-sm text-muted-foreground italic">{t("localizationPlugins.ui_No_special_permissions_requested_")}</p>
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
// PluginLocalFoldersSettings — host-managed company-scoped folders
// ---------------------------------------------------------------------------

interface PluginLocalFoldersSettingsProps {
  pluginId: string;
  companyId: string | null;
  declarations: PluginLocalFolderDeclaration[];
}

function PluginLocalFoldersSettings({ pluginId, companyId, declarations }: PluginLocalFoldersSettingsProps) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: companyId
      ? queryKeys.plugins.localFolders(pluginId, companyId)
      : ["plugins", pluginId, "companies", "none", "local-folders"],
    queryFn: () => pluginsApi.listLocalFolders(pluginId, companyId!),
    enabled: !!companyId,
  });

  const statusByKey = new Map((data?.folders ?? []).map((folder) => [folder.folderKey, folder]));

  if (!companyId) {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">{t("localizationPlugins.ui_Select_an_organization_to_configure_this_plugin_s_local_folders_")}</div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("localizationPlugins.ui_Local_folders")}</h3>
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {(error as Error).message || t("localizationPlugins.folderLoadFailed")}
        </div>
      ) : null}
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{t("localizationPlugins.ui_Loading_local_folders_")}</div>
      ) : (
        <div className="space-y-3">
          {declarations.map((declaration) => (
            <PluginLocalFolderRow
              key={declaration.folderKey}
              pluginId={pluginId}
              companyId={companyId}
              declaration={declaration}
              status={statusByKey.get(declaration.folderKey)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PluginLocalFolderRowProps {
  pluginId: string;
  companyId: string;
  declaration: PluginLocalFolderDeclaration;
  status?: PluginLocalFolderStatus;
}

function PluginLocalFolderRow({ pluginId, companyId, declaration, status }: PluginLocalFolderRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const serverPath = status?.path ?? "";
  const [pathValue, setPathValue] = useState(serverPath);
  const [message, setMessage] = useState<{ type: "success" | "error"; text?: string; translationKey?: string } | null>(null);

  useEffect(() => {
    setPathValue(serverPath);
    setMessage(null);
  }, [serverPath, declaration.folderKey]);

  const saveMutation = useMutation({
    mutationFn: (path: string) =>
      pluginsApi.configureLocalFolder(pluginId, companyId, declaration.folderKey, {
        path,
        access: declaration.access,
        requiredDirectories: declaration.requiredDirectories,
        requiredFiles: declaration.requiredFiles,
      }),
    onSuccess: (nextStatus) => {
      setMessage({
        type: nextStatus.healthy ? "success" : "error",
        translationKey: nextStatus.healthy
          ? "localizationPlugins.folderSaved"
          : "localizationPlugins.folderSavedNeedsAttention",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.plugins.localFolders(pluginId, companyId) });
    },
    onError: (err: Error) => {
      setMessage({ type: "error", text: err.message, translationKey: "localizationPlugins.folderSaveFailed" });
    },
  });

  const trimmedPath = pathValue.trim();
  const isDirty = trimmedPath !== serverPath;
  const access = status?.access ?? declaration.access ?? "readWrite";

  const handleSave = useCallback(() => {
    if (!trimmedPath) {
      setMessage({ type: "error", translationKey: "localizationPlugins.folderRequired" });
      return;
    }
    if (!isLikelyAbsolutePath(trimmedPath)) {
      setMessage({ type: "error", translationKey: "localizationPlugins.folderAbsolute" });
      return;
    }
    setMessage(null);
    saveMutation.mutate(trimmedPath);
  }, [saveMutation, trimmedPath, t]);

  return (
    <div className="space-y-4 rounded-md border border-border/70 bg-background px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">{declaration.displayName}</h4>
            <Badge variant="outline" className="font-mono text-(length:--text-nano)">
              {declaration.folderKey}
            </Badge>
            <Badge variant={status?.healthy ? "default" : "secondary"}>
              {status?.healthy ? t("localizationPlugins.ui_Healthy") : t("localizationPlugins.ui_Needs_attention")}
            </Badge>
          </div>
          {declaration.description ? (
            <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
              {declaration.description}
            </p>
          ) : null}
        </div>
        <Badge variant={access === "readWrite" ? "default" : "outline"}>
          {access === "readWrite" ? t("localizationPlugins.ui_Read_write") : t("localizationPlugins.ui_Read_only")}
        </Badge>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <FolderStatusMetric label={t("localizationPlugins.ui_Configured")} value={status?.configured ? t("localizationPlugins.yes") : t("localizationPlugins.no")} ok={!!status?.configured} />
        <FolderStatusMetric label={t("localizationPlugins.ui_Readable")} value={status?.readable ? t("localizationPlugins.yes") : t("localizationPlugins.no")} ok={!!status?.readable} />
        <FolderStatusMetric
          label={t("localizationPlugins.ui_Writable")}
          value={access === "read" ? t("localizationPlugins.notRequested") : status?.writable ? t("localizationPlugins.yes") : t("localizationPlugins.no")}
          ok={access === "read" || !!status?.writable}
        />
      </div>

      {status?.path ? (
        <div className="space-y-1 text-sm">
          <div className="text-xs font-medium text-muted-foreground">{t("localizationPlugins.ui_Configured_path")}</div>
          <div className="break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs text-foreground">
            {status.path}
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`local-folder-${declaration.folderKey}`}>{t("localizationPlugins.ui_Local_folder_path")}</label>
        <div className="flex items-center gap-2">
          <input
            id={`local-folder-${declaration.folderKey}`}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-ring/20"
            value={pathValue}
            onChange={(event) => {
              setPathValue(event.target.value);
              setMessage(null);
            }}
            placeholder="/absolute/path/to/folder"
          />
          <ChoosePathButton className="h-8" />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saveMutation.isPending || !isDirty || !companyId}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}{t("localizationPlugins.ui_Save")}</Button>
        </div>
      </div>

      <FolderRequirements status={status} declaration={declaration} />

      {status?.problems?.length ? (
        <div className="space-y-2 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <div className="font-medium">{t("localizationPlugins.ui_Validation_problems")}</div>
          <ul className="space-y-1">
            {status.problems.map((problem, index) => (
              <li key={`${problem.code}:${problem.path ?? ""}:${index}`}>
                {problem.message}
                {problem.path ? <span className="font-mono"> {problem.path}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {message ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-400"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {message.text || t(message.translationKey!)}
        </div>
      ) : null}
    </div>
  );
}

function FolderStatusMetric({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  useTranslation();
  return (
    <div className="flex items-center justify-between rounded-md border border-border/60 px-2.5 py-2">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant={ok ? "default" : "secondary"}>{value}</Badge>
    </div>
  );
}

function FolderRequirements({
  status,
  declaration,
}: {
  status?: PluginLocalFolderStatus;
  declaration: PluginLocalFolderDeclaration;
}) {
  const { t } = useTranslation();
  const requiredDirectories = status?.requiredDirectories ?? declaration.requiredDirectories ?? [];
  const requiredFiles = status?.requiredFiles ?? declaration.requiredFiles ?? [];
  const missingDirectories = status?.missingDirectories ?? requiredDirectories;
  const missingFiles = status?.missingFiles ?? requiredFiles;
  const rootNotInspected = isRootNotInspected(status);

  if (requiredDirectories.length === 0 && requiredFiles.length === 0) return null;

  return (
    <div className="grid gap-3 text-sm md:grid-cols-2">
      <RequirementList
        title={t("localizationPlugins.ui_Required_directories")}
        items={requiredDirectories}
        missingItems={missingDirectories}
        missingLabel={t("localizationPlugins.missingDirectories")}
        inspectionUnavailable={rootNotInspected}
      />
      <RequirementList
        title={t("localizationPlugins.ui_Required_files")}
        items={requiredFiles}
        missingItems={missingFiles}
        missingLabel={t("localizationPlugins.missingFiles")}
        inspectionUnavailable={rootNotInspected}
      />
    </div>
  );
}

function isRootNotInspected(status?: PluginLocalFolderStatus) {
  if (!status?.configured || status.readable) return false;
  return status.problems.some((problem) =>
    problem.code === "missing" || problem.code === "not_readable" || problem.code === "not_directory"
  );
}

function RequirementList({
  title,
  items,
  missingItems,
  missingLabel,
  inspectionUnavailable,
}: {
  title: string;
  items: string[];
  missingItems: string[];
  missingLabel: string;
  inspectionUnavailable?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-md border border-border/60 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        {inspectionUnavailable ? (
          <Badge variant="secondary" className="text-(length:--text-nano)">{t("localizationPlugins.ui_Not_inspected")}</Badge>
        ) : missingItems.length > 0 ? (
          <Badge variant="destructive" className="text-(length:--text-nano)">
            {t("localizationPlugins.missingCount", { count: missingItems.length })}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-(length:--text-nano)">{t("localizationPlugins.ui_Present")}</Badge>
        )}
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => {
            const missing = missingItems.includes(item);
            return (
              <span
                key={item}
                className={`rounded border px-1.5 py-0.5 font-mono text-(length:--text-micro) ${
                  inspectionUnavailable
                    ? "border-amber-300/60 bg-amber-50 text-amber-700 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-300"
                    : missing
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-border bg-muted/50 text-foreground/80"
                }`}
              >
                {item}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("localizationPlugins.ui_None_declared_")}</p>
      )}
      {inspectionUnavailable ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t("localizationPlugins.ui_Configured_root_was_not_inspected_")}</p>
      ) : missingItems.length > 0 ? (
        <p className="text-xs text-destructive">{missingLabel}: {missingItems.join(", ")}</p>
      ) : null}
    </div>
  );
}

function isLikelyAbsolutePath(pathValue: string) {
  return (
    pathValue.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(pathValue) ||
    pathValue.startsWith("\\\\")
  );
}

// ---------------------------------------------------------------------------
// PluginConfigForm — auto-generated form for instanceConfigSchema
// ---------------------------------------------------------------------------

interface PluginConfigFormProps {
  pluginId: string;
  companyId: string | null;
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
function PluginConfigForm({ pluginId, companyId, schema, initialValues, isLoading, pluginStatus, supportsConfigTest }: PluginConfigFormProps) {
  const { t } = useTranslation();
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
    hasHydratedRef.current = false;
    setValues(getDefaultValues(schema));
  }, [companyId, pluginId, schema]);

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
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text?: string; translationKey?: string } | null>(null);
  const [testResult, setTestResult] = useState<{ type: "success" | "error"; text?: string; translationKey?: string } | null>(null);

  // Dirty tracking: compare against initial values
  const isDirty = JSON.stringify(values) !== JSON.stringify({
    ...getDefaultValues(schema),
    ...(initialValues ?? {}),
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) => {
      if (!companyId) throw new Error(t("localizationPlugins.selectOrganizationSave"));
      return pluginsApi.saveConfig(pluginId, companyId, configJson);
    },
    onSuccess: () => {
      setSaveMessage({ type: "success", translationKey: "localizationPlugins.configurationSaved" });
      setTestResult(null);
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.plugins.config(pluginId, companyId) });
      }
      // Clear success message after 3s
      setTimeout(() => setSaveMessage(null), 3000);
    },
    onError: (err: Error) => {
      setSaveMessage({ type: "error", text: err.message, translationKey: "localizationPlugins.configurationSaveFailed" });
    },
  });

  // Test configuration mutation
  const testMutation = useMutation({
    mutationFn: (configJson: Record<string, unknown>) => {
      if (!companyId) throw new Error(t("localizationPlugins.selectOrganizationTest"));
      return pluginsApi.testConfig(pluginId, companyId, configJson);
    },
    onSuccess: (result) => {
      if (result.valid) {
        setTestResult({ type: "success", translationKey: "localizationPlugins.testPassed" });
      } else {
        setTestResult({ type: "error", text: result.message, translationKey: "localizationPlugins.testFailed" });
      }
    },
    onError: (err: Error) => {
      setTestResult({ type: "error", text: err.message, translationKey: "localizationPlugins.testFailed" });
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
        <Loader2 className="h-4 w-4 animate-spin" />{t("localizationPlugins.ui_Loading_configuration_")}</div>
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
          {saveMessage.text || t(saveMessage.translationKey!)}
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
          {testResult.text || t(testResult.translationKey!)}
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("localizationPlugins.ui_Saving_")}</>
          ) : (
            t("localizationPlugins.ui_Save_Configuration")
          )}
        </Button>
        {pluginStatus === "ready" && supportsConfigTest && (
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending || !companyId}
            size="sm"
          >
            {testMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />{t("pages.newAgent.testing")}</>
            ) : (
              t("localizationPlugins.ui_Test_Configuration")
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
  if (totalSeconds < 60) return t("localizationPlugins.uptimeSeconds", { seconds: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return t("localizationPlugins.uptimeMinutes", { minutes, seconds: totalSeconds % 60 });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("localizationPlugins.uptimeHours", { hours, minutes: minutes % 60 });
  const days = Math.floor(hours / 24);
  return t("localizationPlugins.uptimeDays", { days, hours: hours % 24 });
}

/**
 * Format a duration in milliseconds to a compact display string.
 */
function formatDecimal(value: number): string {
  return new Intl.NumberFormat(i18n.resolvedLanguage, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return t("localizationPlugins.durationMilliseconds", { value: ms });
  if (ms < 60000) return t("localizationPlugins.durationSeconds", { value: formatDecimal(ms / 1000) });
  return t("localizationPlugins.durationMinutes", { value: formatDecimal(ms / 60000) });
}

/**
 * Format an ISO timestamp to a relative time string (e.g., "2m ago").
 */
function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return t("localizationPlugins.justNow");
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return t("localizationPlugins.secondsAgo", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("localizationPlugins.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("localizationPlugins.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("localizationPlugins.daysAgo", { count: days });
}

/**
 * Format a unix timestamp (ms since epoch) to a locale string.
 */
function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString(i18n.resolvedLanguage);
}

/**
 * Status indicator dot for job run statuses.
 */
function JobStatusDot({ status }: { status: string }) {
  useTranslation();
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
      title={pluginStatusLabel(status)}
    />
  );
}

/**
 * Status indicator dot for webhook delivery statuses.
 */
function DeliveryStatusDot({ status }: { status: string }) {
  useTranslation();
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
      title={pluginStatusLabel(status)}
    />
  );
}
