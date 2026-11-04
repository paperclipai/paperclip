import {
  isBatchableNativeTextEvent,
  type AppendedEventReceipt,
  type AppendControlPlaneEventOptions,
  type ControlPlanePort,
} from "./contracts/control-plane-port.js";
import type { PrpEvent } from "./protocol/replay-contract.js";

const MAX_BATCH_EVENTS = 64;
const MAX_BATCH_BYTES = 64 * 1024;

type BufferedEvent = { event: PrpEvent; bytes: number | null };
type ReadOutcome =
  | { ok: true; result: IteratorResult<PrpEvent> }
  | { ok: false; error: unknown };

function bufferedEvent(event: PrpEvent): BufferedEvent {
  return {
    event,
    bytes: isBatchableNativeTextEvent(event)
      ? Buffer.byteLength(JSON.stringify(event), "utf8")
      : null,
  };
}

function sameStream(left: PrpEvent, right: PrpEvent): boolean {
  return left.runId === right.runId
    && left.normalizedSessionId === right.normalizedSessionId
    && left.sourceInstanceId === right.sourceInstanceId
    && left.turnId === right.turnId;
}

/**
 * One owner of the transformed session iterator and its append operations.
 * Read ahead only during an ordinary text write; never wait to fill a batch.
 */
export class NativeEventPersistence implements AsyncIterator<PrpEvent> {
  readonly #iterator: AsyncIterator<PrpEvent>;
  readonly #port: Pick<ControlPlanePort, "appendEvent" | "appendEvents">;
  readonly #buffered: BufferedEvent[] = [];
  readonly #committed: Array<{ event: PrpEvent; receipt: AppendedEventReceipt }> = [];
  readonly #receipts = new WeakMap<PrpEvent, AppendedEventReceipt>();
  #pendingRead: Promise<void> | undefined;
  #readOutcome: ReadOutcome | undefined;
  #stopped = false;

  constructor(
    iterator: AsyncIterator<PrpEvent>,
    port: Pick<ControlPlanePort, "appendEvent" | "appendEvents">,
  ) {
    this.#iterator = iterator;
    this.#port = port;
  }

  #requestRead(): Promise<void> {
    if (this.#readOutcome !== undefined) return Promise.resolve();
    if (this.#pendingRead !== undefined) return this.#pendingRead;
    try {
      this.#pendingRead = Promise.resolve(this.#iterator.next()).then(
        result => {
          this.#readOutcome = { ok: true, result };
          this.#pendingRead = undefined;
        },
        error => {
          this.#readOutcome = { ok: false, error };
          this.#pendingRead = undefined;
        },
      );
    } catch (error) {
      this.#readOutcome = { ok: false, error };
      return Promise.resolve();
    }
    return this.#pendingRead;
  }

  async next(): Promise<IteratorResult<PrpEvent>> {
    if (this.#stopped) return { value: undefined, done: true };
    const committed = this.#committed.shift();
    if (committed !== undefined) {
      this.#receipts.set(committed.event, committed.receipt);
      return { value: committed.event, done: false };
    }
    const buffered = this.#buffered.shift();
    if (buffered !== undefined) return { value: buffered.event, done: false };
    await this.#requestRead();
    const outcome = this.#readOutcome!;
    if (!outcome.ok) throw outcome.error;
    // Keep end-of-stream stable for the governed accounting drain.
    if (!outcome.result.done) this.#readOutcome = undefined;
    return outcome.result;
  }

  async #collect(scope: PrpEvent, writing: () => boolean): Promise<void> {
    let bytes = this.#buffered.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    if (this.#buffered.some(entry => entry.bytes === null || !sameStream(scope, entry.event))) return;
    while (writing() && !this.#stopped && this.#buffered.length < MAX_BATCH_EVENTS && bytes < MAX_BATCH_BYTES) {
      // A pending read belongs to this owner even if the write finishes first.
      // Its eventual outcome remains available to next(); no event is discarded.
      await this.#requestRead();
      if (!writing() || this.#stopped) return;
      const outcome = this.#readOutcome!;
      if (!outcome.ok || outcome.result.done) return;
      this.#readOutcome = undefined;
      const entry = bufferedEvent(outcome.result.value);
      this.#buffered.push(entry);
      // Retain at most one nontext, different-stream, or over-budget lookahead.
      if (entry.bytes === null || !sameStream(scope, entry.event) || bytes + entry.bytes > MAX_BATCH_BYTES) return;
      bytes += entry.bytes;
    }
  }

  async appendEvent(
    event: PrpEvent,
    options?: AppendControlPlaneEventOptions,
  ): Promise<AppendedEventReceipt> {
    options?.signal.throwIfAborted();
    if (this.#stopped) throw new Error("native_event_consumer_stopped");
    const committed = this.#receipts.get(event);
    if (committed !== undefined) {
      this.#receipts.delete(event);
      return committed;
    }
    const first = bufferedEvent(event);
    const batch = [event];
    let bytes = first.bytes ?? 0;
    if (this.#port.appendEvents !== undefined && first.bytes !== null && bytes <= MAX_BATCH_BYTES) {
      while (this.#buffered.length > 0 && batch.length < MAX_BATCH_EVENTS) {
        const entry = this.#buffered[0]!;
        if (entry.bytes === null || !sameStream(event, entry.event) || bytes + entry.bytes > MAX_BATCH_BYTES) break;
        this.#buffered.shift();
        batch.push(entry.event);
        bytes += entry.bytes;
      }
    }

    // Invoke persistence before starting another iterator read. An isolated
    // event therefore takes the same immediate singleton path as before.
    const operation = batch.length > 1
      ? this.#port.appendEvents!(batch, options)
      : this.#port.appendEvent(event, options).then(receipt => [receipt]);
    let writing = true;
    const write = operation.finally(() => { writing = false; });
    if (this.#port.appendEvents !== undefined && first.bytes !== null) {
      void this.#collect(event, () => writing && options?.signal.aborted !== true).catch(error => {
        this.#readOutcome = { ok: false, error };
      });
    }
    const receipts = await write;
    if (receipts.length !== batch.length) throw new Error("native_event_batch_receipt_count_mismatch");
    for (let index = 1; index < batch.length; index += 1) {
      this.#committed.push({ event: batch[index]!, receipt: receipts[index]! });
    }
    return receipts[0]!;
  }

  async return(): Promise<IteratorResult<PrpEvent>> {
    this.#stopped = true;
    this.#buffered.length = 0;
    this.#committed.length = 0;
    return await this.#iterator.return?.() ?? { value: undefined, done: true };
  }
}
