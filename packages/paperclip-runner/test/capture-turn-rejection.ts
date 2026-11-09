// A turn-timeout timer can reject its promise before a test reaches its own
// assertion. Vitest treats a rejection with no attached handler as an
// unhandled rejection and fails the whole file, even if every assertion
// later passes. Call this at the same moment the promise is created, before
// any `await`, so a handler is always in place before the timer can fire.
export function captureTurnRejection<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}
