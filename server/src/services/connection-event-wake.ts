/** Process-local hints and negotiation joins; Cloud retains durable delivery until ACK. */
type Enrollment = { canRun(): boolean; join(signal: AbortSignal): Promise<void> };
type Receiver = { wake(): void; enrollment?: Enrollment; abort: AbortController;
  closed: Promise<never>; rejectClosed(error: Error): void; pending: Map<Promise<void>, Promise<void>>; stop(): void };
const receivers = new WeakMap<object, Receiver>();
export function registerConnectionEventWake(owner: object, wake: () => void, enrollment?: Enrollment) {
  receivers.get(owner)?.stop();
  let rejectClosed!: (error: Error) => void;
  const closed = new Promise<never>((_resolve, reject) => { rejectClosed = reject; });
  void closed.catch(() => undefined);
  const abort = new AbortController(), pending = new Map<Promise<void>, Promise<void>>();
  const entry: Receiver = { wake, enrollment, abort, closed, rejectClosed, pending, stop() {
    if (abort.signal.aborted) return;
    const error = new Error("Connection event owner was unregistered");
    abort.abort(error); rejectClosed(error); pending.clear();
  } };
  receivers.set(owner, entry);
  return () => { entry.stop(); if (receivers.get(owner) === entry) receivers.delete(owner); };
}
export function wakeConnectionEvents(owner: object): boolean {
  const receiver = receivers.get(owner);
  if (!receiver || receiver.abort.signal.aborted) return false;
  receiver.wake(); return true;
}

/** Join only the registered owner's actual signed negotiation, never its event drain. */
export function joinConnectionEventWakeEnrollment(owner: object): Promise<void> {
  const receiver = receivers.get(owner), enrollment = receiver?.enrollment;
  if (!receiver || !enrollment || receiver.abort.signal.aborted || !enrollment.canRun())
    return Promise.reject(new Error("Connection event enrollment owner is unavailable"));
  let source: Promise<void>;
  try { source = enrollment.join(receiver.abort.signal); }
  catch (error) { return Promise.reject(error); }
  const pending = receiver.pending.get(source); if (pending) return pending;
  const joined = Promise.race([source, receiver.closed]).then(() => {
    if (receivers.get(owner) !== receiver || receiver.abort.signal.aborted || !enrollment.canRun())
      throw new Error("Connection event enrollment owner changed");
  });
  receiver.pending.set(source, joined);
  const remove = () => { if (receiver.pending.get(source) === joined) receiver.pending.delete(source); };
  void joined.then(remove, remove);
  return joined;
}

/** Inspection never emits a wake or polls the broker. */
export const hasConnectionEventWakeReceiver = (owner: object): boolean => receivers.has(owner);
