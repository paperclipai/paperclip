/**
 * App-wide connectivity state.
 *
 * One small external store answers "can we reach the Paperclip server right
 * now?" for the whole app. Inputs:
 *
 * - React Query cache events: a connectivity-level failure (network drop, proxy
 *   5xx, gateway `tenant_app_unavailable`) makes the store suspicious; any
 *   success confirms the server is reachable.
 * - The live-updates WebSocket opening (reachable) or closing (suspicious).
 * - `navigator.onLine` and the window `online`/`offline` events.
 *
 * A suspicion is confirmed by probing `/api/health` before the state changes,
 * so one busy route returning 503 cannot pause the whole app. While the state
 * is not `online`, a single probe loop polls `/api/health` with backoff (1s,
 * 2s, 5s, 10s, then every 15s; a longer `Retry-After` wins). It is the only
 * outage poll in the app.
 *
 * `lib/query-client.ts` feeds this store into React Query's `onlineManager`,
 * so queries and replayable mutations pause during an outage and resume on
 * recovery instead of failing.
 */

import { createContext, createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { apiFetch } from "@/api/client";
import { isConnectivityError, isTransientError, parseRetryAfter } from "@/api/errors";

export type ConnectivityStatus = "online" | "reconnecting" | "offline";

export interface ConnectivitySnapshot {
  status: ConnectivityStatus;
  /** When the current outage began (first failed request), or null while online. */
  troubleSince: number | null;
  /** When the store last recovered from an outage. */
  recoveredAt: number | null;
  /** Writes waiting for the connection, as reported by `usePendingWritesReporter`. */
  pendingWrites: number;
}

export type ProbeResult = { reachable: true } | { reachable: false; retryAfterMs: number | null };

export interface ConnectivityStoreOptions {
  /** Checks whether the server is reachable. Defaults to probing `/api/health`. */
  probe?: () => Promise<ProbeResult>;
  now?: () => number;
  /** Initial browser connectivity; defaults to `navigator.onLine`. */
  browserOnline?: boolean;
}

/** Delay before each probe while reconnecting; the last value repeats. */
export const PROBE_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const;
/** Upper bound for a server-requested `Retry-After`. */
export const MAX_PROBE_DELAY_MS = 60_000;
/** Do not re-check a suspicion this soon after a probe said the server is fine. */
export const SUSPICION_COOLDOWN_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface ConnectivityStore {
  getSnapshot(): ConnectivitySnapshot;
  subscribe(listener: () => void): () => void;
  /** Report a failed request. Only connectivity-level errors have an effect. */
  reportError(error: unknown): void;
  /** Report a successful request: the server is reachable. */
  reportSuccess(): void;
  /**
   * Health says the server is `starting`: reachable, but not ready. Unlike an
   * outage, ordinary successful requests do not end this state; only a health
   * probe that reports `ok` does.
   */
  reportServerStarting(): void;
  reportSocketStatus(status: "open" | "closed"): void;
  setBrowserOnline(online: boolean): void;
  /** During an outage, probe now instead of waiting out the backoff step (a Retry button). */
  probeNow(): void;
  /** Called once each time the store returns to `online` after an outage. */
  onRecover(listener: () => void): () => void;
  setPendingWrites(sourceId: string, count: number): void;
  /** Attach `online`/`offline` window listeners. Returns a cleanup. */
  start(): () => void;
  /** Stop timers and drop listeners (tests). */
  dispose(): void;
}

function readBrowserOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export function createConnectivityStore(options: ConnectivityStoreOptions = {}): ConnectivityStore {
  const probe = options.probe ?? probeServerHealth;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const recoverListeners = new Set<() => void>();
  const pendingWriteSources = new Map<string, number>();

  let browserOnline = options.browserOnline ?? readBrowserOnline();
  let snapshot: ConnectivitySnapshot = {
    status: browserOnline ? "online" : "offline",
    troubleSince: browserOnline ? null : now(),
    recoveredAt: null,
    pendingWrites: 0,
  };
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let probing = false;
  let probeAttempt = 0;
  /** First connectivity failure not yet confirmed or dismissed by a probe. */
  let suspectedSince: number | null = null;
  let lastClearProbeAt = Number.NEGATIVE_INFINITY;
  let serverStarting = false;
  let disposed = false;
  /** Bumped by every proof of reachability; a failed probe started before one is stale. */
  let recoveries = 0;
  /** Bumped by every `starting` report; a reachable probe started before one is stale. */
  let startingReports = 0;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  const update = (next: Partial<ConnectivitySnapshot>) => {
    const merged = { ...snapshot, ...next };
    if (
      merged.status === snapshot.status
      && merged.troubleSince === snapshot.troubleSince
      && merged.recoveredAt === snapshot.recoveredAt
      && merged.pendingWrites === snapshot.pendingWrites
    ) return;
    snapshot = merged;
    emit();
  };

  const clearProbeTimer = () => {
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  };

  const recover = () => {
    recoveries += 1;
    clearProbeTimer();
    suspectedSince = null;
    probeAttempt = 0;
    if (snapshot.status === "online") return;
    update({ status: "online", troubleSince: null, recoveredAt: now() });
    for (const listener of [...recoverListeners]) listener();
  };

  const enterReconnecting = (since: number) => {
    if (snapshot.status !== "online") return;
    update({ status: "reconnecting", troubleSince: since });
  };

  const scheduleProbe = (retryAfterMs: number | null) => {
    clearProbeTimer();
    if (disposed || !browserOnline) return;
    const backoff = PROBE_BACKOFF_MS[Math.min(probeAttempt, PROBE_BACKOFF_MS.length - 1)];
    const delay = retryAfterMs === null ? backoff : Math.min(Math.max(backoff, retryAfterMs), MAX_PROBE_DELAY_MS);
    probeAttempt += 1;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      runProbe();
    }, delay);
  };

  const runProbe = () => {
    if (disposed || probing || !browserOnline) return;
    probing = true;
    const recoveriesAtStart = recoveries;
    const startingReportsAtStart = startingReports;
    void probe()
      .catch((): ProbeResult => ({ reachable: false, retryAfterMs: null }))
      .then((result) => {
        probing = false;
        if (disposed || !browserOnline) return;
        const stale = result.reachable
          ? startingReports !== startingReportsAtStart
          : recoveries !== recoveriesAtStart;
        if (stale) {
          // Newer evidence arrived while this probe was in flight (a success,
          // or a `starting` report), so it wins over this result. If that left
          // the app reconnecting, keep the loop alive: nothing else will
          // probe. Otherwise check again only if something failed since.
          if (snapshot.status !== "online") scheduleProbe(result.reachable ? null : result.retryAfterMs);
          else if (suspectedSince !== null) runProbe();
          return;
        }
        if (result.reachable) {
          if (snapshot.status === "online") lastClearProbeAt = now();
          serverStarting = false;
          recover();
          return;
        }
        enterReconnecting(suspectedSince ?? now());
        suspectedSince = null;
        scheduleProbe(result.retryAfterMs);
      });
  };

  const suspect = () => {
    if (disposed || !browserOnline) return;
    if (snapshot.status !== "online") return; // The probe loop is already running.
    suspectedSince ??= now();
    if (probing) return;
    if (now() - lastClearProbeAt < SUSPICION_COOLDOWN_MS) {
      suspectedSince = null;
      return;
    }
    runProbe();
  };

  const reportSuccess = () => {
    if (!browserOnline || serverStarting) return;
    recover();
  };

  const reportServerStarting = () => {
    if (disposed || serverStarting) return;
    serverStarting = true;
    startingReports += 1;
    if (!browserOnline) return;
    enterReconnecting(now());
    if (probeTimer === null && !probing) scheduleProbe(null);
  };

  const setBrowserOnline = (online: boolean) => {
    if (online === browserOnline) return;
    browserOnline = online;
    if (!online) {
      clearProbeTimer();
      suspectedSince = null;
      update({ status: "offline", troubleSince: snapshot.troubleSince ?? now() });
      return;
    }
    // The browser has a network again; confirm the server before trusting it.
    update({ status: "reconnecting" });
    probeAttempt = 0;
    clearProbeTimer();
    runProbe();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportError(error) {
      if (isConnectivityError(error)) suspect();
    },
    reportSuccess,
    reportServerStarting,
    reportSocketStatus(status) {
      if (status === "open") reportSuccess();
      else suspect();
    },
    setBrowserOnline,
    probeNow() {
      if (snapshot.status === "online") return;
      clearProbeTimer();
      runProbe();
    },
    onRecover(listener) {
      recoverListeners.add(listener);
      return () => {
        recoverListeners.delete(listener);
      };
    },
    setPendingWrites(sourceId, count) {
      if (count > 0) pendingWriteSources.set(sourceId, count);
      else pendingWriteSources.delete(sourceId);
      let total = 0;
      for (const value of pendingWriteSources.values()) total += value;
      update({ pendingWrites: total });
    },
    start() {
      if (typeof window === "undefined") return () => undefined;
      const handleOnline = () => setBrowserOnline(true);
      const handleOffline = () => setBrowserOnline(false);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      setBrowserOnline(readBrowserOnline());
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    },
    dispose() {
      disposed = true;
      clearProbeTimer();
      listeners.clear();
      recoverListeners.clear();
    },
  };
}

/**
 * Probe `/api/health` directly (not through `healthApi`, which may trigger a
 * tenant-session recovery redirect). Reachable means the server answered with
 * a non-transient response; a `starting` server is not ready yet.
 */
export async function probeServerHealth(): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await apiFetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A proxy's HTML page: the app itself did not answer.
      return res.ok || res.status >= 500 ? { reachable: false, retryAfterMs } : { reachable: true };
    }
    if (res.ok) {
      const status = body && typeof body === "object" ? (body as { status?: unknown }).status : undefined;
      return status === "ok" ? { reachable: true } : { reachable: false, retryAfterMs };
    }
    return isTransientError({ status: res.status, body })
      ? { reachable: false, retryAfterMs }
      : { reachable: true };
  } catch {
    return { reachable: false, retryAfterMs: null };
  } finally {
    clearTimeout(timeout);
  }
}

/** The app's connectivity store. */
export const connectivity = createConnectivityStore();

const ConnectivityContext = createContext<ConnectivityStore>(connectivity);

/** Override the store for a subtree (tests, Storybook). The app uses the singleton. */
export function ConnectivityProvider({ store, children }: { store: ConnectivityStore; children?: ReactNode }) {
  return createElement(ConnectivityContext.Provider, { value: store }, children);
}

export function useConnectivityStore(): ConnectivityStore {
  return useContext(ConnectivityContext);
}

export function useConnectivity(): ConnectivitySnapshot {
  const store = useConnectivityStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * Report writes that are waiting for the connection (drafts queued to resend,
 * autosaves held back). The banner shows the total. Durable write queues
 * feed this; `bindConnectivity` counts paused replayable mutations.
 */
export function usePendingWritesReporter(sourceId: string, count: number): void {
  const store = useConnectivityStore();
  useEffect(() => {
    store.setPendingWrites(sourceId, count);
  }, [store, sourceId, count]);
  useEffect(() => () => store.setPendingWrites(sourceId, 0), [store, sourceId]);
}
