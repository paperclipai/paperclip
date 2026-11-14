
export const MIN_ACTIVE_DEADLINE_SEC = 30;

export const MAX_ACTIVE_DEADLINE_SEC = 24 * 60 * 60;

export interface BoundedLeaseDeadline {
  activeDeadlineSec: number;
  hardStopAtEpochSec: number;
  expiresAt: string;
}

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
  const hardStopAtEpochSec = Math.floor(nowMs / 1000) + activeDeadlineSec;
  return {
    activeDeadlineSec,
    hardStopAtEpochSec,
    expiresAt: new Date(hardStopAtEpochSec * 1000).toISOString(),
  };
}
