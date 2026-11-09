export const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;

/** Bound history reads, including body consumption, and release coalesced GETs
 * on timeout so Retry starts a fresh request. Late responses cannot commit. */
export function readTranscriptRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("History read cancelled", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => {
      finish(() => reject(new DOMException("History read cancelled", "AbortError")));
      controller.abort();
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("Run history took too long to load. Retry to load it.")));
      controller.abort();
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      request(controller.signal).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
