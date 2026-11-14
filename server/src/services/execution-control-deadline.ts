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
export const EXECUTION_FINALIZATION_DEADLINE_EXCEEDED = "execution_finalization_deadline_exceeded";
export const EXECUTION_FINALIZATION_DEADLINE_MESSAGE =
  "The run stopped before it finished saving its work. Saved work is kept, and actions with unconfirmed outcomes will not be repeated.";
