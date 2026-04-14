import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";
import { useI18n } from "../context/I18nContext";

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { t, formatRelativeTime } = useI18n();
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = devServer.lastChangedAt ? formatRelativeTime(devServer.lastChangedAt) : null;
  const reason =
    devServer.reason === "backend_changes_and_pending_migrations"
      ? t("dev_restart.reason_backend_and_migrations")
      : devServer.reason === "pending_migrations"
        ? t("dev_restart.reason_pending_migrations")
        : t("dev_restart.reason_backend_changed");
  const sample = devServer.changedPathsSample.slice(0, 3);

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("dev_restart.restart_required")}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {t("dev_restart.auto_restart_on")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {reason}
            {changedAt ? ` · ${t("dev_restart.updated", { value: changedAt })}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {t("dev_restart.changed")}: {sample.join(", ")}
                {devServer.changedPathCount > sample.length
                  ? ` ${t("dev_restart.more_count", { count: devServer.changedPathCount - sample.length })}`
                  : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {t("dev_restart.pending_migrations")}: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2
                  ? ` ${t("dev_restart.more_count", { count: devServer.pendingMigrations.length - 2 })}`
                  : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{t("dev_restart.waiting_for_runs", { count: devServer.activeRunCount })}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("dev_restart.auto_restart_when_idle")}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("dev_restart.restart_command_hint")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
