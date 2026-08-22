/**
 * Detects when a new frontend build has been deployed while a tab is still open.
 *
 * Long-lived tabs keep running the JS bundle they loaded at page-load, so a
 * deployed fix (e.g. the React perf-measure memory fix) doesn't reach them until
 * they happen to reload. The service worker (`public/sw.js`) is a static file
 * that doesn't change between builds, so the normal SW `updatefound` flow never
 * fires for a JS-only deploy. Instead we compare the *hashed bundle filename*
 * (which Vite changes every build) against the freshly-served `index.html`.
 */

// Vite emits the entry as `assets/index-<hash>.js`. Match just the filename.
const BUNDLE_FILENAME_RE = /(index-[A-Za-z0-9_-]+\.js)/;

/** The bundle filename this page actually loaded, from its <script> tags. */
export function getLoadedBundleId(doc: Document = document): string | null {
  for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = script.getAttribute("src") ?? "";
    const match = src.match(BUNDLE_FILENAME_RE);
    if (match) return match[1]!;
  }
  return null;
}

/** The entry bundle filename referenced by a served index.html string. */
export function parseBundleIdFromHtml(html: string): string | null {
  const match = html.match(/<script[^>]+src=["'][^"']*?(index-[A-Za-z0-9_-]+\.js)["']/i);
  return match ? match[1]! : null;
}

export async function fetchDeployedBundleId(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl("/index.html", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    return parseBundleIdFromHtml(await res.text());
  } catch {
    return null;
  }
}

export interface AppUpdateWatcherOptions {
  currentBundleId: string | null;
  onUpdateAvailable: (deployedBundleId: string) => void;
  /** Poll interval; also re-checks when the tab regains focus/visibility. */
  intervalMs?: number;
  /** Injectable for tests. */
  getDeployedBundleId?: () => Promise<string | null>;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Poll for a newer deployed bundle. Fires `onUpdateAvailable` at most once
 * (updates are latched), then keeps quiet until the caller reloads. Returns a
 * stop function.
 */
export function startAppUpdateWatcher(opts: AppUpdateWatcherOptions): () => void {
  const { currentBundleId, onUpdateAvailable, intervalMs = DEFAULT_INTERVAL_MS } = opts;
  // If we can't identify our own bundle, we can't compare — do nothing.
  if (!currentBundleId) return () => {};
  const getDeployed = opts.getDeployedBundleId ?? (() => fetchDeployedBundleId());

  let stopped = false;
  let notified = false;

  const check = async () => {
    if (stopped || notified) return;
    const deployed = await getDeployed();
    if (stopped || notified) return;
    if (deployed && deployed !== currentBundleId) {
      notified = true;
      onUpdateAvailable(deployed);
    }
  };

  const interval = setInterval(() => void check(), intervalMs);
  const onVisible = () => {
    if (typeof document === "undefined" || document.visibilityState === "visible") void check();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  if (typeof window !== "undefined") window.addEventListener("focus", onVisible);

  return () => {
    stopped = true;
    clearInterval(interval);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.removeEventListener("focus", onVisible);
  };
}
