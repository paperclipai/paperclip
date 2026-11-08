import { t, useTranslation, Trans } from "@/i18n";
import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { Badge } from "@/components/ui/badge";

const RESTART_PENDING_RESET_MS = 30_000;

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return t("task-components:justNow_7ddb44d8");
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return t("task-components:mAgo_28f5747c", { value1: deltaMinutes });
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return t("task-components:hAgo_51452941", { value1: deltaHours });
  const deltaDays = Math.round(deltaHours / 24);
  return t("task-components:dAgo_0dc906ea", { value1: deltaDays });
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return t("final-components-a:backendFilesChangedAndMigrations_d06a3c07");
  }
  if (devServer.reason === "pending_migrations") {
    return t("final-components-a:pendingMigrationsNeedAFresh_1714f36d");
  }
  return t("final-components-a:backendFilesChangedSinceThis_8895af8f");
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  useTranslation("task-components");
  const [restartPending, setRestartPending] = useState(false);
  useEffect(() => {
    if (!restartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending]);

  if (!devServer?.enabled || !devServer.restartRequired) return null;

  const currentDevServer = devServer;
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunLabel = t("final-components-a:liveRuns", { count: devServer.activeRunCount });

  async function requestRestartNow() {
    const warning =
      currentDevServer.activeRunCount > 0
        ? t("final-components-a:restartPaperclipNowThisMay_092ce98a", { runs: activeRunLabel })
        : t("final-components-a:restartPaperclipNow_6fd743cc");
    if (!window.confirm(warning)) return;

    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      window.alert(error instanceof Error ? error.message : t("final-components-a:failedToRequestRestart_807a9e71"));
    }
  }

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{t("task-components:restartRequired_5e0716dc")}</span>
            {devServer.autoRestartEnabled ? (
              <Badge variant="ghost" className="bg-amber-900/10 text-(length:--text-nano) tracking-(--tracking-eyebrow) dark:bg-amber-100/10">{t("task-components:autoRestartOn_0bf77a45")}</Badge>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer)}
            {changedAt ? t("final-components-a:updatedTime_4252ecf7", { time: changedAt }) : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span><Trans ns="task-components" i18nKey="sentence_ebb64ab44a4c" components={{ part1: <>{sample.join(", ")}</>, part2: <>{devServer.changedPathCount > sample.length ? t("final-components-a:countMore_cfc63c5f", { count: devServer.changedPathCount - sample.length }) : ""}</> }} /></span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span><Trans ns="task-components" i18nKey="sentence_aaf949653b81" components={{ part1: <>{devServer.pendingMigrations.slice(0, 2).join(", ")}</>, part2: <>{devServer.pendingMigrations.length > 2 ? t("final-components-a:countMore_cfc63c5f", { count: devServer.pendingMigrations.length - 2 }) : ""}</> }} /></span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span><Trans ns="task-components" i18nKey="sentence_7b15d95cb65a" components={{ part1: <>{activeRunLabel}</> }} /></span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t("task-components:autoRestartWillTriggerWhenTheInstance_f49f9acf")}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span><Trans ns="task-components" i18nKey="sentence_02ae43a6eaab" components={{ part1: <>{<code>pnpm dev:once</code>}</> }} /></span>
            </div>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
            onClick={() => {
              void requestRestartNow();
            }}
            disabled={restartPending}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{restartPending ? t("task-components:restartRequested_8427d283") : t("task-components:restartNow_09af1002")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
