// Measures how long each page takes to load, for hard loads and client-side
// navigations, and hands finished measurements to the tracing SDK once it has
// loaded. The definitions live in doc/browser-performance-tracing.md.
//
// This module is in the main bundle and imports no OpenTelemetry code. It runs
// only when browser tracing is active for this page session.
//
// A measurement ends at the first animation frame, observed on
// `stableFrames` consecutive frames, in which:
//   1. no blocking gate (full-page loading state) is mounted, and
//   2a. when the page declared content gates: every content gate is ready
//       (the end time is the latest gate's paint time), otherwise
//   2b. no query that has no data yet is fetching (the end time is the first
//       such frame).
// A new navigation interrupts an open one.
//
// A measurement in a tab that is hidden when it starts, or that hides before
// it is ready, ends with outcome `hidden` at the moment the tab hid. Browsers
// stop painting hidden tabs, so it could never become ready; the same rule as
// `web-vitals`, which stops reporting LCP and FCP once the page has been
// hidden.
//
// A measurement that has not ended `timeoutMs` after it started ends with
// outcome `timeout`, and its end time is exactly start + `timeoutMs`. Any end
// observed after that deadline (a timer that fired late, a frame that ran
// after the computer woke up) is reported as that timeout, never as a longer
// duration. When the observed end, or a gap between two frames, is more than
// `SUSPEND_GRACE_MS` late, the measurement is marked `suspended`: the
// computer slept or the tab was frozen while it was open.

import type { PageContentGateSnapshot } from "./page-content-gates";

export type PageLoadType = "hard" | "client";
export type PageLoadOutcome = "ready" | "timeout" | "interrupted" | "hidden";
export type PageLoadReadySignal = "content" | "idle";

export interface PageLoadMeasurement {
  readonly id: number;
  routeTemplate: string;
  readonly loadType: PageLoadType;
  /** `performance.now()` time; 0 for a hard load (navigation start). */
  readonly startTime: number;
  endTime: number | null;
  outcome: PageLoadOutcome | null;
  readySignal: PageLoadReadySignal | null;
  /** The tab was hidden at some point during the measurement. */
  wasHidden: boolean;
  /** The computer slept or the tab froze while the measurement was open. */
  suspended: boolean;
  /** The page's `?view=`, from an allowlist (`page-view.ts`); null for pages without views. */
  view: string | null;
}

/** Receives measurements; implemented by the lazily loaded tracing SDK. */
export interface PageLoadSink {
  begin(measurement: PageLoadMeasurement): void;
  end(measurement: PageLoadMeasurement): void;
}

export interface PageLoadRecorderDeps {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  isDocumentHidden(): boolean;
  hasPendingPrimaryData(): boolean;
  readGates(): PageContentGateSnapshot;
  /** The current page view for `routeTemplate` (`pageViewFor`). */
  readView?(routeTemplate: string): string | null;
}

export interface PageLoadRecorderOptions {
  timeoutMs?: number;
  stableFrames?: number;
  /** Finished measurements kept while no sink is attached. */
  bufferLimit?: number;
}

export interface PageLoadRecorder {
  /**
   * `hiddenAt`: when the tab was first hidden after `startTime`, if it was
   * hidden before this call (a hard load opened in a background tab).
   */
  begin(input: { routeTemplate: string; loadType: PageLoadType; startTime: number; hiddenAt?: number | null }): PageLoadMeasurement;
  /**
   * A redirect (history replace) while a measurement is open continues it
   * under the new route, as does one right after a measurement that ended
   * hidden and has not been exported yet. Returns false otherwise.
   */
  redirect(routeTemplate: string): boolean;
  open(): PageLoadMeasurement | null;
  currentRouteTemplate(): string | null;
  hardLoadRouteTemplate(): string | null;
  /** The tab became hidden at `time`: an open measurement ends as `hidden`. */
  noteHidden(time: number): void;
  attachSink(sink: PageLoadSink): void;
  stop(): void;
}

export const PAGE_LOAD_TIMEOUT_MS = 30_000;
/** An end, or a frame, this much later than expected means the computer slept. */
export const SUSPEND_GRACE_MS = 5_000;

export function createPageLoadRecorder(
  deps: PageLoadRecorderDeps,
  options: PageLoadRecorderOptions = {},
): PageLoadRecorder {
  const timeoutMs = options.timeoutMs ?? PAGE_LOAD_TIMEOUT_MS;
  const stableFrames = Math.max(1, options.stableFrames ?? 2);
  const bufferLimit = options.bufferLimit ?? 20;

  let nextId = 1;
  let current: PageLoadMeasurement | null = null;
  let latestRoute: string | null = null;
  let hardLoadRoute: string | null = null;
  let sink: PageLoadSink | null = null;
  let stopped = false;
  let frame: number | null = null;
  let timer: unknown = null;
  let streak = 0;
  let streakStart = 0;
  let lastFrameAt: number | null = null;
  let lastEnded: PageLoadMeasurement | null = null;
  const buffered: PageLoadMeasurement[] = [];

  function cancelScheduled() {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  }

  function readView(routeTemplate: string): string | null {
    return deps.readView ? deps.readView(routeTemplate) : null;
  }

  function finish(measurement: PageLoadMeasurement, outcome: PageLoadOutcome, endTime: number, signal: PageLoadReadySignal | null) {
    if (current === measurement) {
      current = null;
      cancelScheduled();
    }
    const deadline = measurement.startTime + timeoutMs;
    if (endTime > deadline) {
      // Not ready by the deadline, whatever happened after it.
      if (endTime - deadline > SUSPEND_GRACE_MS) measurement.suspended = true;
      outcome = "timeout";
      signal = null;
      endTime = deadline;
    }
    if (outcome === "hidden") measurement.wasHidden = true;
    // An interrupted measurement keeps the view it had: the URL already
    // belongs to the next page.
    if (outcome !== "interrupted") measurement.view = readView(measurement.routeTemplate);
    measurement.outcome = outcome;
    measurement.readySignal = signal;
    measurement.endTime = Math.max(measurement.startTime, endTime);
    lastEnded = measurement;
    if (measurement.loadType === "hard") hardLoadRoute = measurement.routeTemplate;
    if (sink) {
      sink.end(measurement);
      return;
    }
    buffered.push(measurement);
    if (buffered.length > bufferLimit) buffered.shift();
  }

  function tick() {
    frame = null;
    const measurement = current;
    if (!measurement || stopped) return;
    const time = deps.now();
    if (deps.isDocumentHidden()) {
      finish(measurement, "hidden", time, null);
      return;
    }
    if (lastFrameAt !== null && time - lastFrameAt > SUSPEND_GRACE_MS) measurement.suspended = true;
    lastFrameAt = time;

    const gates = deps.readGates();
    let signal: PageLoadReadySignal | null = null;
    if (gates.blockingCount === 0) {
      if (gates.contentCount > 0) {
        if (gates.pendingContentCount === 0) signal = "content";
      } else if (!deps.hasPendingPrimaryData()) {
        signal = "idle";
      }
    }

    if (signal === null) {
      streak = 0;
    } else {
      if (streak === 0) streakStart = time;
      streak += 1;
      if (streak >= stableFrames) {
        const endTime = signal === "content" && gates.lastContentReadyAt !== null
          ? gates.lastContentReadyAt
          : streakStart;
        finish(measurement, "ready", endTime, signal);
        return;
      }
    }
    frame = deps.requestFrame(tick);
  }

  function schedule(measurement: PageLoadMeasurement) {
    streak = 0;
    lastFrameAt = null;
    frame = deps.requestFrame(tick);
    const remaining = Math.max(0, measurement.startTime + timeoutMs - deps.now());
    timer = deps.setTimer(() => {
      timer = null;
      if (current === measurement) finish(measurement, "timeout", deps.now(), null);
    }, remaining);
  }

  return {
    begin({ routeTemplate, loadType, startTime, hiddenAt = null }) {
      // The open measurement ends where this one starts, so no request or
      // time is counted under both.
      if (current) finish(current, "interrupted", Math.min(deps.now(), startTime), null);
      const hidden = hiddenAt !== null || deps.isDocumentHidden();
      const measurement: PageLoadMeasurement = {
        id: nextId++,
        routeTemplate,
        loadType,
        startTime,
        endTime: null,
        outcome: null,
        readySignal: null,
        wasHidden: hidden,
        suspended: false,
        view: readView(routeTemplate),
      };
      latestRoute = routeTemplate;
      if (stopped) return measurement;
      current = measurement;
      sink?.begin(measurement);
      if (hidden) finish(measurement, "hidden", hiddenAt ?? startTime, null);
      else schedule(measurement);
      return measurement;
    },
    redirect(routeTemplate) {
      latestRoute = routeTemplate;
      if (!current) {
        // A load in a background tab ends as soon as it starts; its redirect
        // (for example `/` to the dashboard) renames it rather than starting
        // a second, also hidden, measurement.
        const ended = lastEnded;
        if (ended?.outcome !== "hidden" || !deps.isDocumentHidden() || !buffered.includes(ended)) return false;
        ended.routeTemplate = routeTemplate;
        ended.view = readView(routeTemplate);
        if (ended.loadType === "hard") hardLoadRoute = routeTemplate;
        return true;
      }
      current.routeTemplate = routeTemplate;
      streak = 0;
      return true;
    },
    open: () => current,
    currentRouteTemplate: () => latestRoute,
    hardLoadRouteTemplate: () => hardLoadRoute ?? (current?.loadType === "hard" ? current.routeTemplate : null),
    noteHidden(time) {
      if (current) finish(current, "hidden", time, null);
    },
    attachSink(next) {
      if (stopped) return;
      sink = next;
      for (const measurement of buffered.splice(0)) {
        next.begin(measurement);
        next.end(measurement);
      }
      if (current) next.begin(current);
    },
    stop() {
      stopped = true;
      cancelScheduled();
      current = null;
      sink = null;
      buffered.length = 0;
    },
  };
}
