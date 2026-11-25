/**
 * Paired app + Vite HMR port allocation for the `tailscale_https` exposure mode.
 *
 * A managed runtime that opts into HTTPS exposure needs TWO deterministically
 * related loopback ports reserved together (PAP-17049 plan, PAP-17050 verdict
 * requirement #2): the app port and its Paperclip Vite HMR companion at a fixed
 * offset. Allocating them as a pair — and only from the dedicated allowlisted
 * range — means a compromised caller can never ask the broker to publish an
 * arbitrary existing loopback service, and the HMR listener is never orphaned
 * from its app listener.
 *
 * Pure orchestration over an injected availability probe: no sockets here, so
 * the scan order and skip logic are unit-testable.
 */
import {
  RUNTIME_EXPOSURE_APP_PORT_MIN,
  RUNTIME_EXPOSURE_APP_PORT_MAX,
  deriveViteHmrPort,
  isRuntimeExposureAppPort,
} from "@paperclipai/shared";

export interface ExposurePortPair {
  appPort: number;
  hmrPort: number;
}

export interface AllocateExposurePortPairInput {
  /**
   * Returns true if the port can currently be bound loopback-only. Both the app
   * port and its HMR companion must pass before a pair is returned.
   */
  isPortAvailable: (port: number) => Promise<boolean>;
  /**
   * Ports that must never be handed out — e.g. quarantined after an ambiguous
   * cleanup, or already reserved by other live runtimes this cycle.
   */
  reserved?: ReadonlySet<number>;
  /**
   * The port this runtime is already using, if any. Tried first so a restart or
   * a backfilled service keeps its port instead of drifting across the range on
   * every deploy ("keep existing runtime ports when safe", PAP-17158).
   *
   * Only honored when it is genuinely safe: the port must be an allowlisted app
   * port, unreserved, and free together with its HMR companion. A legacy pinned
   * port outside the dedicated range (the Paperclip App template's 45439) can
   * never be published by the broker, so it is ignored here rather than making
   * the caller special-case it.
   */
  preferredAppPort?: number | null;
  /**
   * Atomically take the pair for this allocation, or refuse it. Returning false
   * makes the scan move on as if the pair were busy.
   *
   * Without it, two concurrent allocators observe identical reservations and
   * identical probe results and both walk away with the lowest free pair —
   * neither has bound anything yet, so nothing downstream can tell them apart.
   * The claim must cover both ports together: a half-claimed pair is the
   * orphaned-HMR-companion failure this allocator exists to prevent.
   */
  claimPair?: (pair: ExposurePortPair) => boolean;
}

/**
 * Return an app port whose HMR companion is also free and unreserved: the
 * preferred port when it is eligible, otherwise the first such port scanning the
 * dedicated range in ascending order. Throws when the range is exhausted so the
 * caller fails closed rather than binding an out-of-range port.
 */
export async function allocateExposurePortPair(
  input: AllocateExposurePortPairInput,
): Promise<ExposurePortPair> {
  const reserved = input.reserved ?? new Set<number>();

  const claimIfFree = async (appPort: number): Promise<ExposurePortPair | null> => {
    if (reserved.has(appPort)) return null;
    if (!isRuntimeExposureAppPort(appPort)) return null;
    const hmrPort = deriveViteHmrPort(appPort);
    if (reserved.has(hmrPort)) return null;
    // Probe the app port first; short-circuit before probing the companion.
    if (!(await input.isPortAvailable(appPort))) return null;
    if (!(await input.isPortAvailable(hmrPort))) return null;
    const pair = { appPort, hmrPort };
    // Claim last: the probes are the cheap filter, and claiming a pair we then
    // reject would leak a hold on it for the claim's whole TTL.
    if (input.claimPair && !input.claimPair(pair)) return null;
    return pair;
  };

  if (input.preferredAppPort != null) {
    const preferred = await claimIfFree(input.preferredAppPort);
    if (preferred) return preferred;
  }

  for (let appPort = RUNTIME_EXPOSURE_APP_PORT_MIN; appPort <= RUNTIME_EXPOSURE_APP_PORT_MAX; appPort += 1) {
    const pair = await claimIfFree(appPort);
    if (pair) return pair;
  }
  throw new Error(
    `no free app/HMR port pair available in the dedicated runtime exposure range ` +
      `[${RUNTIME_EXPOSURE_APP_PORT_MIN}, ${RUNTIME_EXPOSURE_APP_PORT_MAX}]`,
  );
}
