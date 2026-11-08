export const REMOTE_RUNNER_RECONNECT_GRACE_MS = 7 * 60_000;
export const REMOTE_CONTROLLER_LEASE_MS = 60_000;

/**
 * How long a local runnerd keeps running with no authenticated controller.
 *
 * A per-turn runner exits with its turn, so it keeps its connection-lease
 * bound (undefined: no separate process grace). A warm runner outlives its
 * turn: if its controller dies without suspending it (SIGKILL, crash), nothing
 * else owns it. It therefore gets the remote grace, which is far longer than a
 * controller restart, so a live turn still reattaches. After the grace, runnerd
 * proves the controller is gone, stops its provider, keeps its durable state for
 * a cold resume, and exits.
 */
export function localRunnerProcessReconnectGraceMs(
  lifecyclePolicy: { mode: "per_turn" | "warm" },
): number | undefined {
  return lifecyclePolicy.mode === "warm" ? REMOTE_RUNNER_RECONNECT_GRACE_MS : undefined;
}
