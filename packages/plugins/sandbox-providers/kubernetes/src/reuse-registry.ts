/**
 * In-process bookkeeping for reusable (kept-running) sandbox leases.
 *
 * The server keeps a conversation's pod alive between turns by retaining the
 * lease and NOT calling the plugin's release, so the plugin has to enforce the
 * idle TTL itself. It tracks, per lease: when it last did anything (an exec, a
 * resume) and how many execs are in flight. A lease with no execs in flight and
 * no activity for the idle TTL is destroyed by the reaper; the next turn's
 * resume then finds it gone, reports it expired, and the server acquires a
 * fresh lease.
 *
 * Only leases the server marked reusable (`metadata.reusableSandboxLease`) are
 * ever reaped or evicted. Ordinary one-shot leases (Pi, Claude, ...) are never
 * touched here: the server releases them at the end of the run.
 *
 * Limitation: this registry lives in the plugin worker process. After a worker
 * restart, previously idle pods are forgotten until their next turn re-tracks
 * them; the quota-aware eviction and the orphan reaper (TECH-8818) cover them.
 */

import type { KubeClients } from "./kube-client.js";
import { destroyLeaseResources } from "./lease-lifecycle.js";

/** A lease must be idle at least this long before quota pressure may evict it. */
export const EVICTION_MIN_IDLE_MS = 30_000;

export interface TrackedLease {
  namespace: string;
  name: string;
  secretName: string;
  podName: string | null;
  backend: "sandbox-cr" | "job";
  clients: KubeClients;
  idleTtlMs: number;
  lastActivityAt: number;
  inFlight: number;
  /** Set while a destroy is in progress so it is not started twice. */
  destroying?: boolean;
}

const tracked = new Map<string, TrackedLease>();

function keyOf(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

export type TrackInput = Omit<TrackedLease, "lastActivityAt" | "inFlight">;

/** Register (or refresh) a reusable lease. Counts as activity. */
export function trackReusableLease(input: TrackInput, now: number = Date.now()): TrackedLease {
  const key = keyOf(input.namespace, input.name);
  const existing = tracked.get(key);
  if (existing) {
    // Mutate in place: in-flight execs hold a reference to this entry. Never
    // overwrite a known pod name with an unknown one.
    const { podName, ...rest } = input;
    Object.assign(existing, rest, { lastActivityAt: now });
    if (podName) existing.podName = podName;
    return existing;
  }
  const entry: TrackedLease = { ...input, lastActivityAt: now, inFlight: 0 };
  tracked.set(key, entry);
  return entry;
}

export function isTracked(namespace: string, name: string): boolean {
  return tracked.has(keyOf(namespace, name));
}

/** Mark an exec starting; returns a function to call when it finishes. */
export function beginLeaseExec(namespace: string, name: string, now: () => number = Date.now): () => void {
  const entry = tracked.get(keyOf(namespace, name));
  if (!entry) return () => {};
  entry.inFlight += 1;
  entry.lastActivityAt = now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    entry.lastActivityAt = now();
  };
}

export function forgetLease(namespace: string, name: string): void {
  tracked.delete(keyOf(namespace, name));
}

export function resetReuseRegistry(): void {
  tracked.clear();
}

// Forget the lease only once its resources are really gone, so a failed destroy
// is retried by the next reap instead of orphaning the pod.
async function destroy(entry: TrackedLease): Promise<void> {
  entry.destroying = true;
  try {
    await destroyLeaseResources(entry.clients, {
      namespace: entry.namespace,
      name: entry.name,
      backend: entry.backend,
      podName: entry.podName,
      secretName: entry.secretName,
    });
    tracked.delete(keyOf(entry.namespace, entry.name));
  } catch (err) {
    entry.destroying = false;
    throw err;
  }
}

/** Destroy every tracked lease idle past its TTL. Returns the destroyed lease names. */
export async function reapIdleLeases(
  now: number = Date.now(),
  onError: (err: unknown, entry: TrackedLease) => void = () => {},
): Promise<string[]> {
  const reaped: string[] = [];
  for (const entry of [...tracked.values()]) {
    // Re-check after every await: a new exec may have started, or the lease
    // may have been released or destroyed by another path.
    if (entry.destroying || tracked.get(keyOf(entry.namespace, entry.name)) !== entry) continue;
    if (entry.inFlight > 0 || now - entry.lastActivityAt < entry.idleTtlMs) continue;
    try {
      await destroy(entry);
      reaped.push(entry.name);
    } catch (err) {
      onError(err, entry);
    }
  }
  return reaped;
}

/**
 * Free capacity in a company namespace by destroying its longest-idle reusable
 * lease (idle at least EVICTION_MIN_IDLE_MS, nothing in flight). Returns true
 * when a lease was evicted. An idle conversation pod is cheaper to lose than a
 * new turn is to refuse: the evicted conversation just pays a cold start on its
 * next turn.
 */
export async function evictLongestIdleLease(
  namespace: string,
  now: number = Date.now(),
): Promise<boolean> {
  const candidates = [...tracked.values()]
    .filter(
      (entry) =>
        entry.namespace === namespace &&
        !entry.destroying &&
        entry.inFlight === 0 &&
        now - entry.lastActivityAt >= EVICTION_MIN_IDLE_MS,
    )
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  for (const entry of candidates) {
    // Re-check after earlier awaits, like the reaper does.
    if (entry.destroying || tracked.get(keyOf(entry.namespace, entry.name)) !== entry || entry.inFlight > 0) continue;
    try {
      await destroy(entry);
      return true;
    } catch (err) {
      console.warn(
        `[plugin-kubernetes] could not evict idle pod ${entry.namespace}/${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return false;
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;
let reaping = false;

/**
 * Start the periodic idle reaper (idempotent: a second call keeps the running
 * one and returns a no-op stop, so only the call that started it can stop it).
 * The timer never keeps the process alive.
 */
export function startIdleReaper(
  intervalMs: number,
  onError: (err: unknown, entry: TrackedLease) => void,
): () => void {
  if (reaperTimer) return () => {};
  const stop = () => {
    if (reaperTimer) clearInterval(reaperTimer);
    reaperTimer = null;
  };
  reaperTimer = setInterval(() => {
    if (reaping) return; // never overlap two sweeps
    reaping = true;
    reapIdleLeases(Date.now(), onError)
      .catch((err) => console.warn("[plugin-kubernetes] idle reap sweep failed:", err))
      .finally(() => {
        reaping = false;
      });
  }, intervalMs);
  reaperTimer.unref?.();
  return stop;
}
