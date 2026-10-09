import { heartbeatsApi } from "../api/heartbeats";

const LIVE_STATUSES = new Set(["queued", "running", "scheduled_retry"]);

/** A tree hold response acknowledges the hold, not necessarily runner termination. */
export async function waitForStoppedRuns(
  runIds: string[],
  options: {
    getRun?: typeof heartbeatsApi.get;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
) {
  const getRun = options.getRun ?? heartbeatsApi.get;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let remaining = [...new Set(runIds)];
  while (remaining.length > 0) {
    let states;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      states = await Promise.race([
        Promise.all(remaining.map((id) => getRun(id))),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Stop verification timed out")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]);
    } catch {
      throw new Error(
        "The stop was requested, but stopping could not be verified. Refresh and try Stop again if work is still running.",
      );
    } finally {
      clearTimeout(timeout);
    }
    remaining = states
      .filter((run) => {
        if (LIVE_STATUSES.has(run.status)) return true;
        const adapterCancellation = run.resultJson?.executionCancellation;
        if (adapterCancellation && typeof adapterCancellation === "object"
          && "state" in adapterCancellation && adapterCancellation.state !== "acknowledged") return true;
        if (!("runtimeMode" in run) || run.runtimeMode !== "native" || run.status !== "cancelled")
          return false;
        const cancellation = run.resultJson?.nativeCancellation;
        return (
          !cancellation ||
          typeof cancellation !== "object" ||
          !("dispatchState" in cancellation) ||
          cancellation.dispatchState !== "acknowledged"
        );
      })
      .map((run) => run.id);
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        "The stop was requested, but work is still stopping. Try Stop again if it continues.",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs ?? 500),
    );
  }
}
