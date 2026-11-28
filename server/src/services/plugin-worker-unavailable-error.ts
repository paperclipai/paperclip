/**
 * Setup failure code for a call that reached a plugin worker which was not
 * running (stopped, crashed, restarting, or not registered). No request was
 * sent to the worker, so the run is retried with the bounded bootstrap budget
 * once the worker is available again.
 */
export const PLUGIN_WORKER_UNAVAILABLE_CODE = "plugin_worker_unavailable";

/** A host call was refused because its plugin worker was not running. */
export class PluginWorkerUnavailableError extends Error {
  readonly code = PLUGIN_WORKER_UNAVAILABLE_CODE;
  readonly pluginId: string;
  /** The worker status at refusal, or null when no worker was registered. */
  readonly workerStatus: string | null;

  constructor(input: { pluginId: string; workerStatus: string | null; message: string }) {
    super(input.message);
    this.name = "PluginWorkerUnavailableError";
    this.pluginId = input.pluginId;
    this.workerStatus = input.workerStatus;
  }
}

/** Find a worker refusal through the orchestrator's error wrappers. */
export function findPluginWorkerUnavailableError(error: unknown): PluginWorkerUnavailableError | null {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    if (cause instanceof PluginWorkerUnavailableError) return cause;
  }
  return null;
}
