/** These bounds apply to lifecycle control work, never to healthy provider execution. */
export const EXECUTION_CONTROL_DEADLINE_MS = 60_000;
export const EXECUTION_RECONCILIATION_INTERVAL_MS = 15_000;
export async function boundedExecutionCleanup(
  operation: () => Promise<unknown>,
  timeoutMs = EXECUTION_CONTROL_DEADLINE_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(operation)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
