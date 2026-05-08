import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import type { DevServerHealthStatus } from "../api/health";

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return i18n.t("relativeTime.justNow");
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return i18n.t("relativeTime.minutesAgo", { count: deltaMinutes });
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return i18n.t("relativeTime.hoursAgo", { count: deltaHours });
  const deltaDays = Math.round(deltaHours / 24);
  return i18n.t("relativeTime.daysAgo", { count: deltaDays });
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return i18n.t("devRestartBanner.backendFilesChangedAndMigrations");
  }
  if (devServer.reason === "pending_migrations") {
    return i18n.t("devRestartBanner.pendingMigrationsNeedBoot");
  }
  return i18n.t("devRestartBanner.backendFilesChanged");
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { t } = useTranslation();
  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("devRestartBanner.restartRequired")}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                {t("devRestartBanner.autoRestartOn")}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer)}
            {changedAt ? ` · ${t("devRestartBanner.updated")} ${changedAt}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                {t("devRestartBanner.changed")}: {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} ${t("devRestartBanner.more")}` : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                {t("devRestartBanner.pendingMigrations")}: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} ${t("devRestartBanner.more")}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.waitingForRuns", { count: devServer.activeRunCount })}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.autoRestartIdle")}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("devRestartBanner.restartInstruction")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
