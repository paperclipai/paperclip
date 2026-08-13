import {
  type AdapterAuthSessionInternalStatus,
  type AdapterAuthSessionStatus,
} from "./types/agent.js";

// The status helpers for an adapter login session. The server and the user
// interface import these helpers, so both sides use one source. The helpers map
// the internal status to the public status and name the active statuses.

// The active internal statuses. The company credential slot allows one active
// session at a time, so the concurrency index applies to exactly these three
// statuses. The `promoting` state stays active because the slot still holds the
// company credential until the promotion window ends.
export const ADAPTER_AUTH_SESSION_ACTIVE_STATUSES = [
  "starting",
  "waiting_for_user",
  "promoting",
] as const satisfies readonly AdapterAuthSessionInternalStatus[];

export type AdapterAuthSessionActiveStatus =
  (typeof ADAPTER_AUTH_SESSION_ACTIVE_STATUSES)[number];

const ACTIVE_STATUS_SET: ReadonlySet<AdapterAuthSessionInternalStatus> = new Set(
  ADAPTER_AUTH_SESSION_ACTIVE_STATUSES,
);

/** Returns true when the status holds the company credential slot. */
export function isActiveAdapterAuthSessionStatus(
  status: AdapterAuthSessionInternalStatus,
): status is AdapterAuthSessionActiveStatus {
  return ACTIVE_STATUS_SET.has(status);
}

/**
 * Maps an internal status to the public status. The map hides the two internal
 * states from a public response:
 *
 * - `promoting` maps to `waiting_for_user`.
 * - `cleanup_pending` throws. It is a terminal-cleanup bookkeeping state. The
 *   caller must resolve the terminal status from the row before it builds a
 *   public response. The throw stops any accidental leak of the cleanup state.
 */
export function toPublicAdapterAuthSessionStatus(
  status: AdapterAuthSessionInternalStatus,
): AdapterAuthSessionStatus {
  switch (status) {
    case "promoting":
      return "waiting_for_user";
    case "cleanup_pending":
      throw new Error(
        "cleanup_pending is an internal cleanup state; resolve the terminal status before you build a public response",
      );
    default:
      return status;
  }
}
