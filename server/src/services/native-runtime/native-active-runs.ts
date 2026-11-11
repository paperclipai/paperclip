export const activeNativeExecutionRunIds = new Set<string>();
const listeners = new Set<() => void>();
export function setNativeExecutionActive(runId: string, active: boolean) {
  if (active) activeNativeExecutionRunIds.add(runId);
  else activeNativeExecutionRunIds.delete(runId);
  for (const listener of listeners) listener();
}
export function subscribeActiveNativeExecutions(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const NATIVE_PREPARATION_FENCING_VERSION = 1;
