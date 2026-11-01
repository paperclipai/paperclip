export const STORAGE_FAILURE_CLEANUP_MS = 5_000;

export async function cleanupStorageFailure(cleanup: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => cleanup(controller.signal)),
      new Promise<void>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, STORAGE_FAILURE_CLEANUP_MS);
      }),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
}
