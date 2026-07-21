import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { getLoadedBundleId, startAppUpdateWatcher } from "../lib/app-update-check";

/**
 * Shows a persistent, dismissible banner when a newer frontend build has been
 * deployed while this tab was open, so long-lived tabs don't keep running a
 * stale (possibly buggy) bundle until they happen to reload. See
 * `lib/app-update-check.ts` for how a new build is detected.
 */
export function AppUpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stop = startAppUpdateWatcher({
      currentBundleId: getLoadedBundleId(),
      onUpdateAvailable: () => setUpdateAvailable(true),
    });
    return stop;
  }, []);

  if (!updateAvailable || dismissed) return null;

  return (
    <aside
      role="status"
      aria-live="polite"
      // Below md the toast viewport (bottom-left, w-full) spans the width, so
      // sit at the top to avoid overlapping it; from md up there is room for
      // both bottom corners.
      className="fixed right-3 top-3 z-(--z-120) w-full max-w-sm px-1 md:top-auto md:bottom-3"
    >
      <div className="pointer-events-auto rounded-sm border border-sky-300 bg-sky-50 text-sky-900 shadow-lg backdrop-blur-xl dark:border-sky-500/25 dark:bg-sky-950/60 dark:text-sky-100">
        <div className="flex items-start gap-3 px-3 py-2.5">
          <RefreshCw className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-5">A new version is available</p>
            <p className="mt-1 text-xs leading-4 opacity-70">Reload to get the latest update.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 inline-flex text-xs font-medium underline underline-offset-4 hover:opacity-90"
            >
              Reload
            </button>
          </div>
          <button
            type="button"
            aria-label="Dismiss update notice"
            onClick={() => setDismissed(true)}
            className="mt-0.5 shrink-0 rounded p-1 opacity-50 hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
