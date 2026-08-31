/**
 * Append one asynchronous input operation to a queue that always remains
 * usable after an operation or diagnostic callback fails.
 */
export function enqueueSerialInput(
  pending: Promise<void>,
  operation: () => Promise<void>,
  onError: (error: unknown) => void | Promise<void>,
): Promise<void> {
  const reportError = (error: unknown): void => {
    try {
      // Diagnostics are best-effort side effects, not input-queue work. Start
      // them in order, but never give an uncooperative callback authority to
      // block later frames or the shutdown drain.
      void Promise.resolve(onError(error)).catch(() => undefined);
    } catch {
      // Diagnostics must not poison the queue or skip later input frames.
    }
  };
  return pending.catch(reportError).then(operation).catch(reportError);
}
