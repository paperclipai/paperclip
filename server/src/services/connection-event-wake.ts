/** Process-local hint only; Cloud retains the durable target until event acknowledgment. */
const receivers = new WeakMap<object, () => void>();
export function registerConnectionEventWake(owner: object, wake: () => void) {
  receivers.set(owner, wake);
  return () => { if (receivers.get(owner) === wake) receivers.delete(owner); };
}
export function wakeConnectionEvents(owner: object): boolean {
  const wake = receivers.get(owner);
  if (!wake) return false;
  wake();
  return true;
}
