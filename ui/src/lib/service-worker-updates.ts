/**
 * Registers `/sw.js` and keeps the installed worker fresh on a long-lived tab.
 *
 * Browsers only re-fetch a service-worker script on navigation or on a ~24h
 * timer. Paperclip is a parked-tab SPA — a tab can stay open for weeks without
 * a single navigation — so without explicit update checks an old worker (and
 * the app shell it cached) can outlive a deploy indefinitely. The symptom is
 * invisible: the tab just keeps running the old bundle.
 *
 * Two behaviors close the gap:
 * - `registration.update()` runs when the tab becomes visible and on an
 *   hourly timer, so parked tabs learn about new workers without navigating.
 * - When a new worker takes control (`controllerchange`), the page reloads
 *   once so the fresh shell actually replaces the running bundle — but only
 *   while the tab is hidden, so an update landing mid-session never yanks
 *   the page out from under the user; a takeover while visible defers the
 *   reload to the next time the tab is hidden. First-ever installs skip the
 *   reload entirely: an uncontrolled page is already running the code the
 *   server just handed it.
 */
const DEFAULT_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export function startServiceWorkerUpdates(
  options: {
    container?: ServiceWorkerContainer;
    documentRef?: Document;
    reload?: () => void;
    updateIntervalMs?: number;
  } = {},
): () => void {
  const container =
    options.container ??
    (typeof navigator !== "undefined" && "serviceWorker" in navigator
      ? navigator.serviceWorker
      : undefined);
  if (!container) {
    return () => {};
  }
  const documentRef = options.documentRef ?? document;
  const reload = options.reload ?? (() => window.location.reload());
  const updateIntervalMs = options.updateIntervalMs ?? DEFAULT_UPDATE_INTERVAL_MS;

  // Only a page that is already worker-controlled is running
  // potentially-stale code when the controller changes; a first-ever
  // install taking control is caching the very bundle the page is running,
  // so reloading would be a no-op. The flag is promoted on that first
  // takeover: any later controller change on this (possibly weeks-old) tab
  // does mean newer code exists.
  let wasControlled = Boolean(container.controller);
  let reloaded = false;
  let reloadPending = false;
  const applyUpdate = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };
  const onControllerChange = () => {
    if (!wasControlled) {
      wasControlled = true;
      return;
    }
    if (documentRef.visibilityState === "hidden") {
      applyUpdate();
    } else {
      reloadPending = true;
    }
  };
  container.addEventListener("controllerchange", onControllerChange);

  let registration: ServiceWorkerRegistration | undefined;
  const checkForUpdates = () => {
    // update() rejects while offline or mid-deploy; the next visibility
    // change or timer tick retries, so failures are deliberately swallowed.
    void registration?.update().catch(() => {});
  };
  const onVisibilityChange = () => {
    if (documentRef.visibilityState === "visible") {
      checkForUpdates();
    } else if (reloadPending) {
      applyUpdate();
    }
  };
  documentRef.addEventListener("visibilitychange", onVisibilityChange);
  const intervalId = setInterval(checkForUpdates, updateIntervalMs);

  void container
    .register("/sw.js")
    .then((reg) => {
      registration = reg;
    })
    .catch(() => {
      // Registration can fail in private windows or hardened browsers; the
      // app works without a worker, it just loses the offline fallback.
    });

  return () => {
    container.removeEventListener("controllerchange", onControllerChange);
    documentRef.removeEventListener("visibilitychange", onVisibilityChange);
    clearInterval(intervalId);
  };
}
