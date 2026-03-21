import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw, TimerReset, Loader2 } from "lucide-react";
import type { DevServerHealthStatus } from "../api/health";

const AUTO_RESTART_DELAY_SECONDS = 30;

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return "backend files changed and migrations are pending";
  }
  if (devServer.reason === "pending_migrations") {
    return "pending migrations need a fresh boot";
  }
  return "backend files changed since this server booted";
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  // Banner is disabled in PM2 production environments with scheduled restarts
  return null;
}

function DevRestartBannerInner({ devServer }: { devServer: DevServerHealthStatus }) {
  const [countdown, setCountdown] = useState(AUTO_RESTART_DELAY_SECONDS);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cancelCountdown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setIsCancelled(true);
  }, []);

  const triggerRestart = useCallback(async () => {
    if (isRestarting) return;
    setIsRestarting(true);

    try {
      await fetch("/api/health/restart", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      // Server will exit; wait a bit then reload the page
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } catch {
      // Server may already be down, try reloading after a delay
      setTimeout(() => {
        window.location.reload();
      }, 5000);
    }
  }, [isRestarting]);

  const hasLiveRuns = devServer.activeRunCount > 0;

  // Only start/resume the countdown when there are no live runs
  useEffect(() => {
    if (hasLiveRuns || isCancelled || isRestarting) {
      // Pause: clear any running timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Start/resume countdown
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [hasLiveRuns, isCancelled, isRestarting]);

  useEffect(() => {
    if (countdown === 0 && !isRestarting && !isCancelled) {
      void triggerRestart();
    }
  }, [countdown, isRestarting, isCancelled, triggerRestart]);

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);

  return (
    <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
      <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>Restart Required</span>
            {!isRestarting && !isCancelled && countdown > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] tabular-nums dark:bg-amber-100/10">
                Auto-restart in {countdown}s
                <button
                  type="button"
                  onClick={cancelCountdown}
                  className="underline opacity-70 hover:opacity-100 transition-opacity"
                >
                  cancel
                </button>
              </span>
            ) : !isRestarting && isCancelled ? (
              <span className="rounded-full bg-amber-900/10 px-2 py-0.5 text-[10px] tracking-[0.14em] dark:bg-amber-100/10">
                Auto-restart paused
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm">
            {describeReason(devServer)}
            {changedAt ? ` · updated ${changedAt}` : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-amber-900/80 dark:text-amber-100/75">
            {sample.length > 0 ? (
              <span>
                Changed: {sample.join(", ")}
                {devServer.changedPathCount > sample.length ? ` +${devServer.changedPathCount - sample.length} more` : ""}
              </span>
            ) : null}
            {devServer.pendingMigrations.length > 0 ? (
              <span>
                Pending migrations: {devServer.pendingMigrations.slice(0, 2).join(", ")}
                {devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} more` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          {isRestarting ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-green-600/20 px-4 py-2 text-green-700 dark:bg-green-400/15 dark:text-green-300">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Restarting server…</span>
            </div>
          ) : devServer.waitingForIdle ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
              <TimerReset className="h-3.5 w-3.5" />
              <span>Waiting for {devServer.activeRunCount} live run{devServer.activeRunCount === 1 ? "" : "s"} to finish</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void triggerRestart()}
              className="inline-flex items-center gap-2 rounded-full bg-amber-600 px-4 py-2 text-white shadow-sm transition-all hover:bg-amber-700 hover:shadow-md active:scale-95 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-amber-950"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Restart Now</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
