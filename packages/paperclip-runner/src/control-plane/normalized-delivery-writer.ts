import type { PrpEvent } from "../protocol/replay-contract.js";
import type { DriverHistoryReceipt, NormalizedDeliveryPort, NormalizedDeliveryRevision, RawDeliveryCursor } from "./normalized-delivery.js";

/** Serializes short reducer steps, not provider RPCs or waits for user input.
 * A synchronous step captures its events and resulting state together. Nothing
 * reaches the run-log consumer before that transaction is durable. */
export class NormalizedDeliveryWriter {
  #revision: NormalizedDeliveryRevision;
  #raw: RawDeliveryCursor;
  #events: PrpEvent[] = [];
  #scheduled = false;
  #tail: Promise<void> = Promise.resolve();
  #failure: Error | null = null;
  #queued = 0;
  #capacityWaiters = new Set<() => void>();

  constructor(
    readonly port: NormalizedDeliveryPort,
    private readonly snapshot: () => Record<string, unknown>,
    private readonly publish: (event: PrpEvent) => void,
    private readonly fail: (error: Error) => void,
    private readonly takeReceipts: () => DriverHistoryReceipt[] = () => [],
  ) {
    const restored = port.load();
    this.#revision = restored?.revision ?? 0;
    this.#raw = restored?.raw ?? { epoch: port.epoch, sourceSeq: 0, ordinal: 0 };
    for (const event of restored?.pending ?? []) publish(structuredClone(event));
  }

  emit(event: PrpEvent): void {
    if (this.#failure) throw this.#failure;
    // The normalized event contract is JSON, matching the run-log boundary.
    // Omitted optional fields must have identical bytes before and after replay.
    this.#events.push(JSON.parse(JSON.stringify(event)) as PrpEvent);
    this.changed();
  }

  get failure(): Error | null { return this.#failure; }

  changed(raw?: RawDeliveryCursor): void {
    if (this.#failure) throw this.#failure;
    if (raw) this.#raw = structuredClone(raw);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => this.#capture());
  }

  #capture(): void {
    if (!this.#scheduled || this.#failure) return;
    this.#scheduled = false;
    try {
      if (++this.#queued > 64) throw new Error("storage_pressure: normalized reducer commit queue is full");
      const events = this.#events.splice(0);
      const batch = { raw: structuredClone(this.#raw), driver: this.snapshot(), events, receipts: this.takeReceipts() };
      this.#tail = this.#tail.then(async () => {
        if (this.#failure) throw this.#failure;
        const committed = await this.port.commit({ ...batch, expectedRevision: this.#revision });
        this.#revision = committed.revision;
        for (const event of events) this.publish(event);
      }).catch((error: unknown) => this.#poison(error)).finally(() => { this.#queued--; });
    } catch (error) { this.#poison(error); }
  }

  #poison(error: unknown): void {
    if (this.#failure) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    for (const wake of this.#capacityWaiters) wake();
    this.#capacityWaiters.clear();
    this.fail(this.#failure);
  }

  async acknowledge(event: PrpEvent): Promise<void> {
    await this.port.acknowledge(event);
    for (const wake of this.#capacityWaiters) wake();
    this.#capacityWaiters.clear();
  }

  async waitForCapacity(): Promise<void> {
    for (;;) {
      if (this.#failure) throw this.#failure;
      const pending = this.port.load()?.pending ?? [];
      if (pending.length < 128 && Buffer.byteLength(JSON.stringify(pending)) < 2 * 1024 * 1024) return;
      await new Promise<void>((resolve) => this.#capacityWaiters.add(resolve));
    }
  }

  async flush(): Promise<void> {
    this.#capture();
    await this.#tail;
    if (this.#failure) throw this.#failure;
  }
}
