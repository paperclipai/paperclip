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
// A new navigation interrupts an open one. A measurement that has not ended
// after `timeoutMs` ends with outcome `timeout`.

import type { PageContentGateSnapshot } from "./page-content-gates";

export type PageLoadType = "hard" | "client";
export type PageLoadOutcome = "ready" | "timeout" | "interrupted";
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
}

export interface PageLoadRecorderOptions {
  timeoutMs?: number;
  stableFrames?: number;
  /** Finished measurements kept while no sink is attached. */
  bufferLimit?: number;
}

export interface PageLoadRecorder {
  begin(input: { routeTemplate: string; loadType: PageLoadType; startTime: number }): PageLoadMeasurement;
  /**
   * A redirect (history replace) while a measurement is open continues it
   * under the new route. Returns false when no measurement is open.
   */
  redirect(routeTemplate: string): boolean;
  open(): PageLoadMeasurement | null;
  currentRouteTemplate(): string | null;
  hardLoadRouteTemplate(): string | null;
  noteHidden(): void;
  attachSink(sink: PageLoadSink): void;
  stop(): void;
}

export const PAGE_LOAD_TIMEOUT_MS = 30_000;

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
  const buffered: PageLoadMeasurement[] = [];

  function cancelScheduled() {
    if (frame !== null) deps.cancelFrame(frame);
    frame = null;
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  }

  function finish(measurement: PageLoadMeasurement, outcome: PageLoadOutcome, endTime: number, signal: PageLoadReadySignal | null) {
    if (current === measurement) {
      current = null;
      cancelScheduled();
    }
    measurement.outcome = outcome;
    measurement.readySignal = signal;
    measurement.endTime = Math.max(measurement.startTime, endTime);
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
    if (deps.isDocumentHidden()) measurement.wasHidden = true;

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
      if (streak === 0) streakStart = deps.now();
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
    frame = deps.requestFrame(tick);
    const remaining = Math.max(0, measurement.startTime + timeoutMs - deps.now());
    timer = deps.setTimer(() => {
      timer = null;
      if (current === measurement) finish(measurement, "timeout", deps.now(), null);
    }, remaining);
  }

  return {
    begin({ routeTemplate, loadType, startTime }) {
      if (current) finish(current, "interrupted", deps.now(), null);
      const measurement: PageLoadMeasurement = {
        id: nextId++,
        routeTemplate,
        loadType,
        startTime,
        endTime: null,
        outcome: null,
        readySignal: null,
        wasHidden: deps.isDocumentHidden(),
      };
      latestRoute = routeTemplate;
      if (stopped) return measurement;
      current = measurement;
      sink?.begin(measurement);
      schedule(measurement);
      return measurement;
    },
    redirect(routeTemplate) {
      latestRoute = routeTemplate;
      if (!current) return false;
      current.routeTemplate = routeTemplate;
      streak = 0;
      return true;
    },
    open: () => current,
    currentRouteTemplate: () => latestRoute,
    hardLoadRouteTemplate: () => hardLoadRoute ?? (current?.loadType === "hard" ? current.routeTemplate : null),
    noteHidden() {
      if (current) current.wasHidden = true;
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
