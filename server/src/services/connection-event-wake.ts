/** Process-local hints only; durable owners retain work until their exact acknowledgment. */
const receivers = new WeakMap<object, Map<() => void, { importsClientMetadata: boolean }>>();
export function registerConnectionEventWake(owner: object, wake: () => void,
  options: { importsClientMetadata?: boolean } = {}) {
  let current = receivers.get(owner);
  if (!current) { current = new Map(); receivers.set(owner, current); }
  const registration = { importsClientMetadata: options.importsClientMetadata === true };
  current.set(wake, registration);
  return () => {
    const active = receivers.get(owner);
    if (active?.get(wake) !== registration) return;
    active.delete(wake);
    if (!active.size) receivers.delete(owner);
  };
}
export function wakeConnectionEvents(owner: object): boolean {
  const current = receivers.get(owner);
  if (!current?.size) return false;
  for (const wake of [...current.keys()]) wake();
  return true;
}
/** Inspection never emits a wake or polls the broker. */
export function hasConnectionEventWakeReceiver(owner: object,
  options: { importsClientMetadata?: boolean } = {}): boolean {
  const current = receivers.get(owner);
  // The default remains the ordinary connection-event capability. Import-only
  // registration must never enroll or suppress polling for ordinary events.
  return Boolean(current && [...current.values()].some(value =>
    value.importsClientMetadata === (options.importsClientMetadata === true)));
}
