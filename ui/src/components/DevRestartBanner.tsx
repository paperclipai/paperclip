import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";
import { useI18n } from "../i18n";

function formatRelativeTimestamp(value: string | null, locale: string): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const deltaMinutes = Math.round((timestamp - Date.now()) / 60_000);
  if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return rtf.format(deltaHours, "hour");
  const deltaDays = Math.round(deltaHours / 24);
  return rtf.format(deltaDays, "day");
}

function describeReason(devServer: DevServerHealthStatus, t: (key: string) => string): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return t("devRestart.reasonBackendAndMigrations");
  }
  if (devServer.reason === "pending_migrations") {
    return t("devRestart.reasonPendingMigrations");
  }
  return t("devRestart.reasonBackendChanged");
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { locale, t } = useI18n();
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt, locale);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const waitingForRuns = t("devRestart.waitingForRuns", {
    count: devServer.activeRunCount,
    suffix: devServer.activeRunCount === 1 ? "" : "s",
  });

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("devRestart.restartRequired")}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {t("devRestart.autoRestartOn")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer, t)}
            {changedAt ? ` · ${t("devRestart.updated")} ${changedAt}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {t("devRestart.changed")}: {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} ${t("devRestart.more")}` : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {t("devRestart.pendingMigrations")}: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} ${t("devRestart.more")}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{waitingForRuns}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestart.autoRestartIdle")}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestart.restartWhenSafe")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
