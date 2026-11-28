import type { DurablePrpControlPlane } from "../../src/control-plane/durable-prp-control-plane.js";

export interface ReadableEvent {
  readonly sourceSeq: number;
  readonly eventType: string;
  /** `performance.now()` when a reader could first see this committed event. */
  readonly at: number;
}

export interface TransportPumpProbe {
  /** How often anything took the control plane's readable state. A transport takes it on every pump pass. */
  stateReads(): number;
  /** Committed events in the order readers could first see them. */
  readonly readable: ReadableEvent[];
  registration(): Promise<{ connectUrl: string; release: () => void }>;
}

/**
 * Test-only observation of one control plane: every wrapped method delegates
 * unchanged. It records when each committed event becomes readable and counts
 * state reads, so a test can tell an event-driven reader from a polling one.
 *
 * `external` selects the production persistence mode, where a non-streaming
 * event stays hidden from readers until its checkpoint is saved.
 */
export function probeTransportPump(
  core: DurablePrpControlPlane,
  persistence: "file" | "external",
  onReadable?: (event: ReadableEvent) => void,
): TransportPumpProbe {
  const readable: ReadableEvent[] = [];
  let lastSeq = 0;
  let reads = 0;
  let observing = false;
  const observe = () => {
    observing = true;
    try {
      for (const event of core.store.state.committedEvents) {
        if (event.sourceSeq <= lastSeq) continue;
        lastSeq = event.sourceSeq;
        const seen = { sourceSeq: event.sourceSeq, eventType: event.eventType, at: performance.now() };
        readable.push(seen);
        onReadable?.(seen);
      }
    } finally {
      observing = false;
    }
  };

  // The working store exists before external persistence replaces the public one.
  const working = core.store as unknown as Record<"commit" | "commitEvent" | "save", (...args: unknown[]) => unknown>;
  for (const method of ["commit", "save"] as const) {
    const original = working[method].bind(working);
    working[method] = (...args: unknown[]) => {
      const result = original(...args);
      observe();
      return result;
    };
  }
  // A staged event write publishes its state partway through, right after it
  // asks whether the sender still owns the session. Look once that synchronous
  // step ends, which is before any timer or I/O callback can read the event.
  const commitEvent = working.commitEvent.bind(working);
  working.commitEvent = (build: unknown, isCurrentOwner: unknown, ...rest: unknown[]) =>
    (commitEvent(build, () => {
      queueMicrotask(observe);
      return (isCurrentOwner as () => boolean)();
    }, ...rest) as Promise<unknown>).finally(observe);
  if (persistence === "external") {
    core.setCheckpointPersistence(async () => undefined);
    const flush = core.flushCheckpoint.bind(core);
    core.flushCheckpoint = () => {
      const saved = flush();
      void saved.then(observe, () => undefined);
      return saved;
    };
  }

  const store = core.store;
  let owner: object | null = store;
  let descriptor: PropertyDescriptor | undefined;
  while (owner !== null && descriptor === undefined) {
    descriptor = Object.getOwnPropertyDescriptor(owner, "state");
    owner = Object.getPrototypeOf(owner);
  }
  const readState = descriptor!.get!;
  Object.defineProperty(store, "state", {
    configurable: true,
    get() {
      if (!observing) reads += 1;
      return readState.call(store);
    },
  });

  return {
    stateReads: () => reads,
    readable,
    async registration() {
      await core.start();
      return { connectUrl: core.connectUrl, release: () => undefined };
    },
  };
}
