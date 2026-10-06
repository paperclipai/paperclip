import { t } from "@/i18n";

/** Translate platform-owned display states without changing plugin/API values. */
export function pluginStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    upgrade_pending: t("localizationPlugins.status_upgrade_pending"),
    uninstalled: t("localizationPlugins.status_uninstalled"),
    installed: t("localizationPlugins.status_installed"),
    registered: t("localizationPlugins.status_registered"),
    ready: t("localizationPlugins.status_ready"),
    enabled: t("localizationPlugins.status_enabled"),
    disabled: t("localizationPlugins.status_disabled"),
    error: t("localizationPlugins.status_error"),
    installing: t("localizationPlugins.status_installing"),
    uninstalling: t("localizationPlugins.status_uninstalling"),
    starting: t("localizationPlugins.status_starting"),
    running: t("localizationPlugins.status_running"),
    stopping: t("localizationPlugins.status_stopping"),
    stopped: t("localizationPlugins.status_stopped"),
    backoff: t("localizationPlugins.status_backoff"),
    crashed: t("localizationPlugins.status_crashed"),
    healthy: t("localizationPlugins.status_healthy"),
    unhealthy: t("localizationPlugins.status_unhealthy"),
    degraded: t("localizationPlugins.status_degraded"),
    pending: t("localizationPlugins.status_pending"),
    queued: t("localizationPlugins.status_queued"),
    succeeded: t("localizationPlugins.status_succeeded"),
    success: t("localizationPlugins.status_success"),
    failed: t("localizationPlugins.status_failed"),
    cancelled: t("localizationPlugins.status_cancelled"),
    received: t("localizationPlugins.status_received"),
    processed: t("localizationPlugins.status_processed"),
    unknown: t("localizationPlugins.status_unknown"),
  };
  return labels[status] ?? status;
}

export function pluginJobTriggerLabel(trigger: string): string {
  const labels: Record<string, string> = {
    schedule: t("localizationPlugins.trigger_schedule"),
    manual: t("localizationPlugins.trigger_manual"),
    retry: t("localizationPlugins.trigger_retry"),
  };
  return labels[trigger] ?? trigger;
}
