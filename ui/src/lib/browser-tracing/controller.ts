// Starts and stops browser performance tracing for one page session.
//
// Main-bundle code. It does nothing unless the authenticated session carries a
// `browserTracing` config, which the server sends only for a hosted Paperclip
// Cloud instance with an operator-set endpoint. When active it:
//   - decides once per page session whether this session is sampled; an
//     unsampled session does nothing else and downloads nothing,
//   - measures the hard load and every client-side navigation
//     (`page-load-recorder.ts`), and
//   - after the page settles, downloads the tracing SDK chunk (`sdk.ts`),
//     which exports the measurements, Web Vitals, and API request spans.
// See doc/browser-performance-tracing.md.

import type { QueryClient } from "@tanstack/react-query";
import type { BrowserTracingConfig } from "@paperclipai/shared";
import { whenPageSettles } from "@/lib/when-page-settles";
import { readPageContentGates } from "./page-content-gates";
import { createPageLoadRecorder, PAGE_LOAD_TIMEOUT_MS, type PageLoadRecorder } from "./page-load-recorder";

export type RouterNavigationType = "PUSH" | "POP" | "REPLACE";

export interface BrowserTracingController {
  /** Called after React commits a new location. */
  onLocationCommitted(pathname: string, navigationType: RouterNavigationType, routeTemplate: string): void;
  stop(): void;
}

export interface TracingSdkHandle {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface TracingSdkModule {
  startTracingSdk(config: BrowserTracingConfig, recorder: PageLoadRecorder): TracingSdkHandle;
}

export interface BrowserTracingControllerOptions {
  queryClient: QueryClient;
  initialPathname: string;
  initialRouteTemplate: string;
  /** Overridable for tests. */
  loadSdk?: () => Promise<TracingSdkModule>;
  random?: () => number;
  /** Overridable for tests; defaults to waiting until the page settles. */
  scheduleSdkLoad?: (start: () => void) => () => void;
  /** Load the SDK by this time even if the page never settles. */
  sdkLoadDeadlineMs?: number;
}

/**
 * Load the SDK no later than this, measured from activation. A page whose
 * requests hang never settles; its hard load then ends as `timeout` at 30 s
 * after navigation start, and this deadline still exports it.
 */
export const SDK_LOAD_DEADLINE_MS = PAGE_LOAD_TIMEOUT_MS + 5_000;

let sessionSampled: boolean | null = null;

/** One decision per page session, so a sampled session is complete. */
export function isPageSessionSampled(sampleRate: number, random: () => number = Math.random): boolean {
  if (sessionSampled === null) sessionSampled = random() < sampleRate;
  return sessionSampled;
}

export function resetPageSessionSampleForTest(): void {
  sessionSampled = null;
}

/** Any query that has no data yet and is fetching is the page's primary data. */
export function hasPendingPrimaryData(queryClient: QueryClient): boolean {
  return queryClient.isFetching({ predicate: (query) => query.state.data === undefined }) > 0;
}

function pathnameOf(url: string | URL | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    return new URL(String(url), window.location.href).pathname;
  } catch {
    return null;
  }
}

/**
 * React Router commits a navigation inside a transition, after any lazy route
 * code has loaded. The history entry changes first, when the user acts, so
 * the navigation start is taken from the history change.
 */
function trackHistoryChanges(now: () => number) {
  let last: { pathname: string; time: number } | null = null;
  const history = window.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const record = (url: string | URL | null | undefined) => {
    const pathname = pathnameOf(url);
    if (pathname) last = { pathname, time: now() };
  };
  history.pushState = function pushState(this: History, ...args: Parameters<History["pushState"]>) {
    record(args[2]);
    return originalPush.apply(this, args);
  };
  history.replaceState = function replaceState(this: History, ...args: Parameters<History["replaceState"]>) {
    record(args[2]);
    return originalReplace.apply(this, args);
  };
  const onPopState = (event: PopStateEvent) => {
    last = { pathname: window.location.pathname, time: event.timeStamp || now() };
  };
  window.addEventListener("popstate", onPopState);
  return {
    takeStart(pathname: string): number | null {
      const entry = last;
      last = null;
      return entry && entry.pathname === pathname ? entry.time : null;
    },
    stop() {
      if (history.pushState !== originalPush) history.pushState = originalPush;
      if (history.replaceState !== originalReplace) history.replaceState = originalReplace;
      window.removeEventListener("popstate", onPopState);
    },
  };
}

export function startBrowserTracingController(
  config: BrowserTracingConfig,
  options: BrowserTracingControllerOptions,
): BrowserTracingController | null {
  if (!isPageSessionSampled(config.sampleRate, options.random)) return null;

  const now = () => performance.now();
  const recorder = createPageLoadRecorder({
    now,
    requestFrame: (callback) => window.requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
    isDocumentHidden: () => document.visibilityState === "hidden",
    hasPendingPrimaryData: () => hasPendingPrimaryData(options.queryClient),
    readGates: readPageContentGates,
  });
  const history = trackHistoryChanges(now);
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") recorder.noteHidden();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // The hard load started at navigation start (time 0), before this code ran.
  recorder.begin({ routeTemplate: options.initialRouteTemplate, loadType: "hard", startTime: 0 });
  let lastPathname = options.initialPathname;

  let stopped = false;
  let sdk: TracingSdkHandle | null = null;
  const loadSdk = options.loadSdk ?? (() => import("./sdk"));
  const schedule = options.scheduleSdkLoad ?? ((start: () => void) => whenPageSettles(options.queryClient, start));
  let loadStarted = false;
  let cancelSettled: () => void = () => {};
  const startLoad = () => {
    if (loadStarted || stopped) return;
    loadStarted = true;
    cancelSettled();
    window.clearTimeout(deadline);
    void loadSdk()
      .then((module) => {
        if (stopped) return;
        sdk = module.startTracingSdk(config, recorder);
      })
      .catch(() => {
        // Tracing is optional; a failed chunk load must not affect the page.
      });
  };
  const deadline = window.setTimeout(startLoad, options.sdkLoadDeadlineMs ?? SDK_LOAD_DEADLINE_MS);
  const cancelSchedule = schedule(startLoad);
  if (loadStarted) cancelSchedule();
  else cancelSettled = cancelSchedule;
  const cancelScheduledLoad = () => {
    cancelSettled();
    window.clearTimeout(deadline);
  };

  return {
    onLocationCommitted(pathname, navigationType, routeTemplate) {
      if (stopped || pathname === lastPathname) return;
      lastPathname = pathname;
      const start = history.takeStart(pathname);
      if (navigationType === "REPLACE" && recorder.redirect(routeTemplate)) return;
      recorder.begin({ routeTemplate, loadType: "client", startTime: start ?? now() });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelScheduledLoad();
      history.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      recorder.stop();
      void sdk?.shutdown();
      sdk = null;
    },
  };
}
