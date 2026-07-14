export function definePlugin<T>(definition: T) {
  return Object.freeze({ definition });
}

export function runWorker() {
  // No-op in unit tests; production workers are started by the host runtime.
}
