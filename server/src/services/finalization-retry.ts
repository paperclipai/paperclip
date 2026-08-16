export async function persistFinalizationStepReliably<T>(
  write: () => Promise<T>,
  retryDelaysMs: readonly number[] = [25, 50],
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      lastError = error;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}
