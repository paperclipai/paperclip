import { describe, expect, it, vi } from "vitest";
import type { AppendedEventReceipt, AppendControlPlaneEventOptions, ControlPlanePort } from "./contracts/control-plane-port.js";
import { NativeEventPersistence } from "./native-event-persistence.js";
import type { PrpEvent } from "./protocol/replay-contract.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function text(seq: number, value = `text-${seq}`): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1", schemaVersion: 1,
    sourceEventId: `runner:run:${seq}`, sourceSeq: seq,
    sourceInstanceId: "runner", sourceKind: "runner", runId: "run",
    normalizedSessionId: "session", turnId: "turn", itemId: "message",
    eventType: "item.delta", priority: 1, emittedAt: "2026-11-03T00:00:00.000Z",
    payload: { kind: "agentMessage", text: value },
  };
}

function receipt(event: PrpEvent): AppendedEventReceipt {
  return { cursor: event.sourceSeq, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
}

class EventStream implements AsyncIterator<PrpEvent> {
  #values: PrpEvent[] = [];
  #pending: ReturnType<typeof deferred<IteratorResult<PrpEvent>>> | undefined;
  #reads: Array<{ count: number; resolve: () => void }> = [];
  reads = 0;
  maxConcurrentReads = 0;

  push(...events: PrpEvent[]) {
    this.#values.push(...events);
    if (this.#pending !== undefined && this.#values.length > 0) {
      this.#pending.resolve({ value: this.#values.shift()!, done: false });
      this.#pending = undefined;
    }
  }

  readCount(count: number): Promise<void> {
    return this.reads >= count ? Promise.resolve() : new Promise(resolve => this.#reads.push({ count, resolve }));
  }

  next(): Promise<IteratorResult<PrpEvent>> {
    if (this.#pending !== undefined) throw new Error("concurrent iterator read");
    this.reads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, 1);
    for (const waiter of this.#reads.splice(0)) {
      if (this.reads >= waiter.count) waiter.resolve();
      else this.#reads.push(waiter);
    }
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    this.#pending = deferred<IteratorResult<PrpEvent>>();
    return this.#pending.promise;
  }

  async return(): Promise<IteratorResult<PrpEvent>> {
    this.#pending?.resolve({ value: undefined, done: true });
    this.#pending = undefined;
    return { value: undefined, done: true };
  }
}

function port() {
  return {
    appendEvent: vi.fn(async (event: PrpEvent, _options?: AppendControlPlaneEventOptions) => receipt(event)),
    appendEvents: vi.fn(async (events: readonly PrpEvent[], _options?: AppendControlPlaneEventOptions) => events.map(receipt)),
  };
}

describe("native text persistence", () => {
  it("starts the first and isolated text writes immediately, without a batch deadline", async () => {
    const stream = new EventStream();
    const persistence = port();
    const firstWrite = deferred<AppendedEventReceipt>();
    persistence.appendEvent.mockImplementationOnce(() => firstWrite.promise);
    const events = new NativeEventPersistence(stream, persistence);
    const first = text(1);
    stream.push(first);
    expect((await events.next()).value).toBe(first);
    const append = events.appendEvent(first);
    expect(persistence.appendEvent).toHaveBeenCalledExactlyOnceWith(first, undefined);
    expect(persistence.appendEvents).not.toHaveBeenCalled();
    firstWrite.resolve(receipt(first));
    await append;
    const second = text(2);
    stream.push(second);
    expect((await events.next()).value).toBe(second);
    const secondAppend = events.appendEvent(second);
    expect(persistence.appendEvent).toHaveBeenLastCalledWith(second, undefined);
    await secondAppend;
    await events.return();
  });

  it("batches ready text without waiting for an outstanding read or reading concurrently", async () => {
    const stream = new EventStream();
    const persistence = port();
    const firstWrite = deferred<AppendedEventReceipt>();
    persistence.appendEvent.mockImplementationOnce(() => firstWrite.promise);
    const batchWrite = deferred<AppendedEventReceipt[]>();
    persistence.appendEvents.mockImplementationOnce(() => batchWrite.promise);
    const events = new NativeEventPersistence(stream, persistence);
    const source = [text(1), text(2), text(3)];
    stream.push(source[0]!);
    await events.next();
    const first = events.appendEvent(source[0]!);
    stream.push(source[1]!, source[2]!);
    await stream.readCount(4); // The fourth read remains pending.
    firstWrite.resolve(receipt(source[0]!));
    await first;
    expect((await events.next()).value).toBe(source[1]);
    const second = events.appendEvent(source[1]!);
    expect(persistence.appendEvents).toHaveBeenCalledExactlyOnceWith(source.slice(1), undefined);
    batchWrite.resolve(source.slice(1).map(receipt));
    await second;
    expect((await events.next()).value).toBe(source[2]);
    expect(await events.appendEvent(source[2]!)).toEqual(receipt(source[2]!));
    expect(persistence.appendEvent).toHaveBeenCalledOnce();
    const late = text(4);
    stream.push(late);
    expect((await events.next()).value).toBe(late);
    await events.appendEvent(late);
    expect(stream.maxConcurrentReads).toBe(1);
    await events.return();
  });

  it.each([
    { eventType: "tool.execution.started", priority: 1, payload: {} },
    { eventType: "run.result.proposed", priority: 0, payload: {} },
    { eventType: "turn.completed", priority: 0, payload: {} },
    { eventType: "item.delta", priority: 0, payload: { kind: "agentMessage", text: "urgent" } },
    { eventType: "item.delta", priority: 1, payload: { kind: "commandExecution", text: "output" } },
    { eventType: "item.delta", priority: 1, sourceKind: "control_plane", payload: { kind: "agentMessage", text: "evidence", evidenceOutcome: "accepted" } },
  ] satisfies Array<Partial<PrpEvent>>)("stops read-ahead at $eventType priority $priority", async boundary => {
    const stream = new EventStream();
    const persistence = port();
    const write = deferred<AppendedEventReceipt>();
    persistence.appendEvent.mockImplementationOnce(() => write.promise);
    const events = new NativeEventPersistence(stream, persistence);
    const first = text(1), second = text(2), control = { ...text(3), ...boundary }, tail = text(4);
    stream.push(first);
    await events.next();
    const append = events.appendEvent(first);
    stream.push(second, control, tail);
    await stream.readCount(3);
    // Let the resolved boundary pass through the reader; no fourth read starts.
    await Promise.resolve();
    await Promise.resolve();
    expect(stream.reads).toBe(3);
    expect(persistence.appendEvent).toHaveBeenCalledOnce();
    write.resolve(receipt(first));
    await append;
    expect((await events.next()).value).toBe(second);
    await events.appendEvent(second);
    expect(stream.reads).toBe(3); // The retained boundary still blocks read-ahead.
    expect((await events.next()).value).toBe(control);
    await events.appendEvent(control);
    expect(persistence.appendEvents).not.toHaveBeenCalled();
    expect(persistence.appendEvent.mock.calls.map(call => call[0])).toEqual([first, second, control]);
    await events.return();
  });

  it("caps buffered event count and submitted batches at 64", async () => {
    const stream = new EventStream();
    const persistence = port();
    const write = deferred<AppendedEventReceipt>();
    persistence.appendEvent.mockImplementationOnce(() => write.promise);
    const events = new NativeEventPersistence(stream, persistence);
    const source = Array.from({ length: 130 }, (_, index) => text(index + 1));
    stream.push(...source);
    await events.next();
    const first = events.appendEvent(source[0]!);
    await stream.readCount(65);
    await Promise.resolve();
    await Promise.resolve();
    expect(stream.reads).toBe(65);
    write.resolve(receipt(source[0]!));
    await first;
    for (let index = 1; index < source.length; index += 1) {
      expect((await events.next()).value).toBe(source[index]);
      await events.appendEvent(source[index]!);
    }
    expect(persistence.appendEvents.mock.calls[0]![0]).toHaveLength(64);
    expect(persistence.appendEvents.mock.calls.every(([batch]) => batch.length <= 64)).toBe(true);
    expect(persistence.appendEvent.mock.calls.length + persistence.appendEvents.mock.calls.flatMap(([batch]) => batch).length)
      .toBe(source.length);
    await events.return();
  });

  it("caps batch bytes and appends an oversized event singly", async () => {
    const stream = new EventStream();
    const persistence = port();
    const write = deferred<AppendedEventReceipt>();
    persistence.appendEvent.mockImplementationOnce(() => write.promise);
    const events = new NativeEventPersistence(stream, persistence);
    const source = [text(1), text(2, "中".repeat(10_000)), text(3, "中".repeat(10_000)), text(4, "x".repeat(70_000))];
    stream.push(...source);
    await events.next();
    const append = events.appendEvent(source[0]!);
    await stream.readCount(4);
    write.resolve(receipt(source[0]!));
    await append;
    for (let index = 1; index < source.length; index += 1) {
      expect((await events.next()).value).toBe(source[index]);
      await events.appendEvent(source[index]!);
    }
    expect(persistence.appendEvents).toHaveBeenCalledOnce();
    expect(persistence.appendEvents.mock.calls.every(([batch]) =>
      batch.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 64 * 1024)).toBe(true);
    expect(persistence.appendEvent.mock.calls.map(call => call[0])).toContain(source[3]);
    await events.return();
  });

  it("preserves singleton behavior for ports without batch support", async () => {
    const stream = new EventStream();
    const write = deferred<AppendedEventReceipt>();
    const persistence = { appendEvent: vi.fn(() => write.promise) };
    const events = new NativeEventPersistence(stream, persistence);
    const source = [text(1), text(2)];
    stream.push(...source);
    await events.next();
    const append = events.appendEvent(source[0]!);
    expect(stream.reads).toBe(1);
    write.resolve(receipt(source[0]!));
    await append;
    expect(stream.reads).toBe(1);
    expect((await events.next()).value).toBe(source[1]);
    await events.return();
  });

  it("does not append buffered text after abort and releases its outstanding reader", async () => {
    const stream = new EventStream();
    const abort = new AbortController();
    let committed = false;
    const release = deferred<void>();
    const persistence: Pick<ControlPlanePort, "appendEvent" | "appendEvents"> = {
      async appendEvent(event, options) {
        await release.promise;
        options?.signal.throwIfAborted();
        committed = true;
        return receipt(event as PrpEvent);
      },
      appendEvents: vi.fn(async batch => batch.map(receipt)),
    };
    const events = new NativeEventPersistence(stream, persistence);
    const source = [text(1), text(2)];
    stream.push(...source);
    await events.next();
    const append = events.appendEvent(source[0]!, { signal: abort.signal });
    await stream.readCount(3);
    abort.abort(new Error("stopped"));
    release.resolve();
    await expect(append).rejects.toThrow("stopped");
    expect(committed).toBe(false);
    await expect(events.appendEvent(source[1]!, { signal: abort.signal })).rejects.toThrow("stopped");
    expect(persistence.appendEvents).not.toHaveBeenCalled();
    await events.return();
    expect(await events.next()).toEqual({ value: undefined, done: true });
    expect(stream.reads).toBe(3);
  });

  it("passes the same cancellation boundary to an in-flight batch", async () => {
    const stream = new EventStream(), abort = new AbortController();
    const firstWrite = deferred<AppendedEventReceipt>(), batchWrite = deferred<void>();
    const persistence = port();
    let committed = false;
    persistence.appendEvent.mockImplementationOnce(() => firstWrite.promise);
    persistence.appendEvents.mockImplementationOnce(async (batch, options) => {
      expect(options?.signal).toBe(abort.signal);
      await batchWrite.promise;
      options?.signal.throwIfAborted();
      committed = true;
      return batch.map(receipt);
    });
    const events = new NativeEventPersistence(stream, persistence);
    const source = [text(1), text(2), text(3)];
    stream.push(...source);
    await events.next();
    const first = events.appendEvent(source[0]!, { signal: abort.signal });
    await stream.readCount(4);
    firstWrite.resolve(receipt(source[0]!));
    await first;
    expect((await events.next()).value).toBe(source[1]);
    const batch = events.appendEvent(source[1]!, { signal: abort.signal });
    expect(persistence.appendEvents).toHaveBeenCalledOnce();
    abort.abort(new Error("batch stopped"));
    batchWrite.resolve();
    await expect(batch).rejects.toThrow("batch stopped");
    expect(committed).toBe(false);
    await events.return();
  });
});
