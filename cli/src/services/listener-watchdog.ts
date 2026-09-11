export type ListenerWatchdogProbe = () => Promise<{ ok: boolean; error?: string }>;

export type ListenerWatchdogOptions = {
  probe: ListenerWatchdogProbe;
  intervalMs?: number;
  failureThreshold?: number;
  onFailure: (details: { failures: number; error?: string }) => void;
};

/**
 * Detect a server process which is still alive but no longer owns a healthy
 * HTTP listener.  The caller owns restart policy; this deliberately only
 * raises one failure after consecutive failed probes.
 */
export function startListenerWatchdog(options: ListenerWatchdogOptions): { stop(): void } {
  const intervalMs = options.intervalMs ?? 5_000;
  const failureThreshold = options.failureThreshold ?? 3;
  let failures = 0;
  let stopped = false;
  let restarting = false;

  const check = async () => {
    if (stopped || restarting) return;
    try {
      const result = await options.probe();
      if (result.ok) {
        failures = 0;
        return;
      }
      failures += 1;
      if (failures >= failureThreshold) {
        restarting = true;
        options.onFailure({ failures, error: result.error });
      }
    } catch (error) {
      failures += 1;
      if (failures >= failureThreshold) {
        restarting = true;
        options.onFailure({
          failures,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
