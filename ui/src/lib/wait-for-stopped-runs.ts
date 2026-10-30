import type { HeartbeatRun } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { heartbeatsApi } from "../api/heartbeats";

const STOPPED_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

const VERIFICATION_ERROR = "The stop was requested, but stopping could not be verified. Refresh and try Stop again if work is still running.";

function isStopped(run: HeartbeatRun) {
  if (!STOPPED_STATUSES.has(run.status)) return false;
  const adapterCancellation = run.resultJson?.executionCancellation;
  if (adapterCancellation && typeof adapterCancellation === "object"
    && "state" in adapterCancellation && adapterCancellation.state !== "acknowledged") return false;
  if (!("runtimeMode" in run) || run.runtimeMode !== "native" || run.status !== "cancelled") return true;
  const cancellation = run.resultJson?.nativeCancellation;
  return Boolean(cancellation && typeof cancellation === "object"
    && "schema" in cancellation && cancellation.schema === "paperclip.native-cancellation.v1"
    && "runId" in cancellation && cancellation.runId === run.id
    && "companyId" in cancellation && cancellation.companyId === run.companyId
    && "dispatchState" in cancellation && cancellation.dispatchState === "acknowledged");
}

/** A cancel response can prove termination; a tree hold alone only acknowledges the hold. */
export async function waitForStoppedRuns(
  runIds: string[],
  options: {
    getRun?: typeof heartbeatsApi.get;
    initialRuns?: Array<HeartbeatRun | null>;
    timeoutMs?: number;
    intervalMs?: number;
  } = {},
) {
  const getRun = options.getRun ?? heartbeatsApi.get;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let remaining = [...new Set(runIds)].filter((id) =>
    !options.initialRuns?.some((run) => run?.id === id && isStopped(run)),
  );
  let transientFailure = false;
  while (remaining.length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(transientFailure ? VERIFICATION_ERROR
        : "The stop was requested, but work is still stopping. Try Stop again if it continues.");
    }
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
    } catch (error) {
      const transient = error instanceof TypeError || (error instanceof ApiError && error.status >= 500);
      if (!transient || Date.now() >= deadline) throw new Error(VERIFICATION_ERROR);
      transientFailure = true;
    } finally {
      clearTimeout(timeout);
    }
    if (states) {
      if (states.some((run, index) => !run || run.id !== remaining[index])) {
        throw new Error(VERIFICATION_ERROR);
      }
      transientFailure = false;
      remaining = remaining.filter((_id, index) => !isStopped(states[index]!));
    }
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        "The stop was requested, but work is still stopping. Try Stop again if it continues.",
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(options.intervalMs ?? 500, Math.max(0, deadline - Date.now()))),
    );
  }
}
