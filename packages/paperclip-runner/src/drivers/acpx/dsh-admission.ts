const DSH_ADMISSION_TIMEOUT_MS = 60_000;

export async function withDshAdmissionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
  releaseLate?: (value: T) => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("DSH admission exceeded its 60-second deadline")), DSH_ADMISSION_TIMEOUT_MS);
  const pending = operation(controller.signal);
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        value => { controller.signal.removeEventListener("abort", onAbort); resolve(value); },
        error => { controller.signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  } catch (error) {
    if (releaseLate) void pending.then(releaseLate).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
