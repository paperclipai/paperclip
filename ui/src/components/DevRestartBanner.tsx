import { useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";
import { devRestartBanner } from "../lib/i18n";
import { relativeTime } from "../lib/utils";

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return relativeTime(value);
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return devRestartBanner.reasonBackendAndMigrations;
  }
  if (devServer.reason === "pending_migrations") {
    return devRestartBanner.reasonPendingMigrations;
  }
  return devRestartBanner.reasonBackendChanges;
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
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
  const extraChanged = Math.max(0, devServer.changedPathCount - sample.length);
  const migrationsShown = devServer.pendingMigrations.slice(0, 2);
  const extraMigrations = Math.max(0, devServer.pendingMigrations.length - migrationsShown.length);

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>{devRestartBanner.title}</span>
            {devServer.autoRestartEnabled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-wide dark:bg-amber-100/10">
                {devRestartBanner.autoRestartOn}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer)}
            {changedAt ? devRestartBanner.updatedAt(changedAt) : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>{devRestartBanner.changedFiles(sample.join(", "), extraChanged)}</span>
            ) : null}
            {migrationsShown.length > 0 ? (
              <span>
                {devRestartBanner.pendingMigrations(migrationsShown.join(", "), extraMigrations)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
          {devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>{devRestartBanner.waitingForRuns(devServer.activeRunCount)}</span>
            </div>
          ) : devServer.autoRestartEnabled ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{devRestartBanner.autoRestartWhenIdle}</span>
            </div>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <RotateCcw className="h-3.5 w-3.5" />
              <span>
                {devRestartBanner.manualRestartBeforeCmd}{" "}
                <code className="rounded bg-amber-900/15 px-1 py-0.5 text-[11px] dark:bg-amber-100/10">
                  pnpm dev:once
                </code>
              </span>
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
            <span>{restartPending ? "Restart requested" : "Restart now"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
