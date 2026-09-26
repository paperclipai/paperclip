/**
 * Computes the provider-side lease-expiry bound for a Kubernetes sandbox pod.
 *
 * TEMPORARY FIX — see README.md "Known limitation: lease expiry attestation
 * is a stopgap, not an upstream fix" for full rationale. This module exists
 * purely so the bounding logic is independently unit-testable without
 * standing up a kind cluster.
 *
 * Paperclip's setup-token-login route (and any other caller that requests a
 * bounded lease) requires every sandbox-provider plugin to return an
 * `expiresAt` that is at or before the caller's requested deadline, and it
 * fails the login closed when a plugin returns none. This module computes
 * that bound and the equivalent Kubernetes `activeDeadlineSeconds`, and
 * mirrors the `daytona` provider's `configureSandboxExpiry`: it FAILS CLOSED
 * (throws) rather than silently granting a near-expired lease when the
 * caller's requested deadline is already past or too close to honor.
 */

/**
 * The minimum deadline-away-from-now, in seconds, this provider will accept
 * before failing closed. Below this, a caller almost certainly cannot
 * complete useful work (e.g. scheduling a pod, execing into it) before the
 * lease expires, so granting it would be a false assurance rather than a
 * real bound.
 */
export const MIN_ACTIVE_DEADLINE_SEC = 30;

/**
 * Upper bound on any granted lease, in seconds (24h). This is a sane-duration
 * ceiling, not just an int32-overflow guard: without it, a caller-requested
 * deadline could grant an effectively unbounded pod lifetime. 24h comfortably
 * covers any real login-PTY session while still being far short of the int32
 * `activeDeadlineSeconds` limit (2,147,483,647s, ~68 years).
 */
export const MAX_ACTIVE_DEADLINE_SEC = 24 * 60 * 60;

export interface BoundedLeaseDeadline {
  /**
   * Seconds to set as the Sandbox pod's `activeDeadlineSeconds`. Kubernetes
   * counts this from the pod's start, which is later than acquisition, so it
   * is only a backstop; `hardStopAtEpochSec` is the real bound.
   */
  activeDeadlineSec: number;
  /**
   * Absolute wall-clock hard stop (Unix seconds). The sandbox entrypoint exits
   * at this instant, which tears down every exec'd process in the container,
   * so the pod never runs past the attested `expiresAt` however late it
   * started.
   */
  hardStopAtEpochSec: number;
  /** ISO 8601 timestamp to return to the server as the lease's `expiresAt`. */
  expiresAt: string;
}

/**
 * Computes a provider-attested lease deadline bounded by the caller's
 * requested expiry.
 *
 * Returns null when the caller requests no deadline: such leases keep the
 * pre-existing behavior (no `expiresAt`, no pod deadline), matching the
 * `daytona` provider and the server's `providerAttestedLeaseExpiry`, which
 * only requires a provider expiry when a deadline was requested.
 *
 * @param requestedExpiresAt - ISO 8601 timestamp from the caller, or
 *   null/undefined when the caller requests no specific deadline.
 * @param nowMs - Injectable clock for deterministic tests; defaults to
 *   `Date.now()`.
 * @throws Error when `requestedExpiresAt` is unparseable, or already at,
 *   before, or within `MIN_ACTIVE_DEADLINE_SEC` of `nowMs` — fails closed
 *   instead of granting a lease the caller did not ask for.
 */
export function computeBoundedLeaseDeadline(
  requestedExpiresAt: string | null | undefined,
  nowMs: number = Date.now(),
): BoundedLeaseDeadline | null {
  if (requestedExpiresAt == null) return null;
  const requestedExpiresAtMs = Date.parse(requestedExpiresAt);
  if (!Number.isFinite(requestedExpiresAtMs)) {
    throw new Error(
      `Requested lease deadline (${JSON.stringify(requestedExpiresAt)}) is not a valid ` +
        `ISO 8601 timestamp. Failing closed instead of silently substituting a default ` +
        `deadline the caller did not ask for.`,
    );
  }
  const requestedDeadlineSec = Math.floor((requestedExpiresAtMs - nowMs) / 1000);
  if (requestedDeadlineSec < MIN_ACTIVE_DEADLINE_SEC) {
    throw new Error(
      `Requested lease deadline (${requestedExpiresAt}) is already past or too close ` +
        `(< ${MIN_ACTIVE_DEADLINE_SEC}s) to acquire a bounded lease. Failing closed instead ` +
        `of granting a near-expired lease.`,
    );
  }
  const activeDeadlineSec = Math.min(requestedDeadlineSec, MAX_ACTIVE_DEADLINE_SEC);
  // Whole seconds, rounded down, so the hard stop never lands after expiresAt.
  const hardStopAtEpochSec = Math.floor(nowMs / 1000) + activeDeadlineSec;
  return {
    activeDeadlineSec,
    hardStopAtEpochSec,
    expiresAt: new Date(hardStopAtEpochSec * 1000).toISOString(),
  };
}
