/** Process-local hint only; Cloud retains the durable target until event acknowledgment. */
type Receiver = { wake(): void; active: boolean };
const receivers = new WeakMap<object, Map<boolean, Receiver>>();
export function registerConnectionEventWake(owner: object, wake: () => void,
  options: { importsClientMetadata?: boolean } = {}) {
  const metadata = options.importsClientMetadata === true;
  let current = receivers.get(owner);
  if (!current) { current = new Map(); receivers.set(owner, current); }
  const previous = current.get(metadata);
  if (previous) previous.active = false;
  const entry: Receiver = { wake, active: true };
  current.set(metadata, entry);
  return () => {
    entry.active = false;
    const active = receivers.get(owner);
    if (active?.get(metadata) !== entry) return;
    active.delete(metadata);
    if (!active.size) receivers.delete(owner);
  };
}
export function wakeConnectionEvents(owner: object): boolean {
  const current = receivers.get(owner);
  if (!current?.size) return false;
  const failures: unknown[] = [];
  let woke = false;
  for (const receiver of [...current.values()]) {
    if (!receiver.active) continue;
    woke = true;
    try { receiver.wake(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Connection event wake hints failed");
  return woke;
}

/** Inspection never emits a wake or polls the broker. */
export function hasConnectionEventWakeReceiver(owner: object,
  options: { importsClientMetadata?: boolean } = {}): boolean {
  return receivers.get(owner)?.get(options.importsClientMetadata === true)?.active === true;
}
