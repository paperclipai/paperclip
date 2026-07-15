import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCcw, TimerReset, X, Zap } from "lucide-react";
import { healthApi, type DevServerHealthStatus } from "../api/health";
import { Badge } from "@/components/ui/badge";

const RESTART_PENDING_RESET_MS = 30_000;

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

function runLabel(count: number): string {
  return `${count} live run${count === 1 ? "" : "s"}`;
}

/**
 * Post-restart confirmation for a hot restart: how many live
 * runs were adopted, finalized while the server was down, or lost, plus the
 * build now running. Surfaced here so the operator sees the same report the
 * deploy routine posts. Dismissible; the server only serves it briefly.
 */
function AdoptionReportBanner({
  report,
  onDismiss,
}: {
  report: NonNullable<DevServerHealthStatus["adoptionReport"]>;
  onDismiss: () => void;
}) {
  const hadLoss = report.lost > 0;
  const wrapperClass = hadLoss
    ? "border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    : "border-emerald-300/60 bg-emerald-50 text-emerald-950 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-100";
  const Icon = hadLoss ? AlertTriangle : CheckCircle2;
  const completedAt = formatRelativeTimestamp(report.completedAt);

  return (
    <div className={`border-b ${wrapperClass}`}>
      <div className="flex flex-col gap-2 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>Hot restart complete</span>
            {completedAt ? <span className="font-normal normal-case opacity-80">· {completedAt}</span> : null}
          </div>
          <p className="mt-1 text-sm">
            <span className="font-medium">{report.adopted}</span> adopted
            {report.finalizedWhileDown > 0 ? (
              <>
                {" · "}
                <span className="font-medium">{report.finalizedWhileDown}</span> finalized while down
              </>
            ) : null}
            {report.lost > 0 ? (
              <>
                {" · "}
                <span className="font-medium">{report.lost}</span> lost
              </>
            ) : null}
            {report.newServerVersion ? (
              <span className="opacity-80">
                {" "}
                — now running <code>{report.newServerVersion}</code>
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss hot restart report"
          className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium opacity-80 transition-opacity hover:opacity-100 md:self-auto"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          <span>Dismiss</span>
        </button>
      </div>
    </div>
  );
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const [restartPending, setRestartPending] = useState(false);
  const [hotRestartPending, setHotRestartPending] = useState(false);
  const [dismissedReportAt, setDismissedReportAt] = useState<string | null>(null);

  useEffect(() => {
    if (!restartPending && !hotRestartPending) return;
    const timeout = window.setTimeout(() => {
      setRestartPending(false);
      setHotRestartPending(false);
    }, RESTART_PENDING_RESET_MS);
    return () => window.clearTimeout(timeout);
  }, [restartPending, hotRestartPending]);

  if (!devServer?.enabled) return null;

  const currentDevServer = devServer;
  const report = devServer.adoptionReport;
  const showReport = Boolean(report) && report?.completedAt !== dismissedReportAt;

  // A fresh boot with an adoption report but nothing stale to rebuild: show only
  // the post-restart confirmation.
  if (!devServer.restartRequired) {
    return showReport && report ? (
      <AdoptionReportBanner report={report} onDismiss={() => setDismissedReportAt(report.completedAt)} />
    ) : null;
  }

  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const sample = devServer.changedPathsSample.slice(0, 3);
  const activeRunLabel = runLabel(devServer.activeRunCount);
  const eligibleLabel = runLabel(devServer.eligibleLiveRunCount);

  async function requestRestartNow() {
    const warning =
      currentDevServer.activeRunCount > 0
        ? `Restart Paperclip now? This may interrupt ${activeRunLabel}.`
        : "Restart Paperclip now?";
    if (!window.confirm(warning)) return;

    setRestartPending(true);
    try {
      await healthApi.requestDevServerRestart();
    } catch (error) {
      setRestartPending(false);
      window.alert(error instanceof Error ? error.message : "Failed to request restart");
    }
  }

  async function requestHotRestart() {
    const warning =
      currentDevServer.eligibleLiveRunCount > 0
        ? `Hot restart Paperclip now? Your ${eligibleLabel} keep running and will be adopted by the new server.`
        : "Hot restart Paperclip now? No live runs are currently eligible to preserve.";
    if (!window.confirm(warning)) return;

    setHotRestartPending(true);
    try {
      await healthApi.requestDevServerRestart({ hot: true });
    } catch (error) {
      setHotRestartPending(false);
      window.alert(error instanceof Error ? error.message : "Failed to request hot restart");
    }
  }

  return (
    <>
      {showReport && report ? (
        <AdoptionReportBanner report={report} onDismiss={() => setDismissedReportAt(report.completedAt)} />
      ) : null}
      <div className="border-b border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100">
        <div className="flex flex-col gap-3 px-3 py-2.5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-caps)">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Restart Required</span>
              {devServer.autoRestartEnabled ? (
                <Badge variant="ghost" className="bg-amber-900/10 text-(length:--text-nano) tracking-(--tracking-eyebrow) dark:bg-amber-100/10">
                  Auto-Restart On
                </Badge>
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

          <div className="flex flex-wrap items-center gap-2 text-xs font-medium md:justify-end">
            {devServer.waitingForIdle ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
                <TimerReset className="h-3.5 w-3.5" />
                <span>Waiting for {activeRunLabel} to finish</span>
              </div>
            ) : devServer.autoRestartEnabled ? (
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Auto-restart will trigger when the instance is idle</span>
              </div>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-900/10 px-3 py-1.5 dark:bg-amber-100/10">
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Restart <code>pnpm dev:once</code> after the active work is safe to interrupt</span>
              </div>
            )}
            {devServer.hotRestartEnabled ? (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-emerald-50 transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400"
                onClick={() => {
                  void requestHotRestart();
                }}
                disabled={hotRestartPending || restartPending}
                title="Restart the server but keep eligible live runs running; they are adopted by the new build."
              >
                <Zap className="h-3.5 w-3.5" />
                <span>
                  {hotRestartPending
                    ? "Hot restart requested"
                    : `Hot restart (keeps ${eligibleLabel})`}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md bg-amber-950 px-3 py-1.5 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-100"
              onClick={() => {
                void requestRestartNow();
              }}
              disabled={restartPending || hotRestartPending}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{restartPending ? "Restart requested" : "Restart now"}</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
