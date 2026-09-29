import type { DriverHistoryCollection, DriverHistoryReceipt, NormalizedDeliveryPort } from "../../control-plane/normalized-delivery.js";

const CACHE_ENTRIES = 128;

/** A cache miss is never permission to forget a completed action. Callers must
 * prefetch the exact keys before entering their synchronous reducer step. */
export class CodexHistoryMap<T> extends Map<string, T> {
  #absent = new Set<string>();
  #dirty = new Map<string, T>();

  constructor(readonly collection: DriverHistoryCollection, private readonly history: NonNullable<NormalizedDeliveryPort["history"]>, entries: Iterable<[string, T]>, restored: boolean, private readonly encode: (value: T) => unknown = (value) => value, private readonly decode: (value: unknown) => T = (value) => value as T) {
    super();
    for (const [key, value] of entries) {
      if (!restored) this.#dirty.set(key, structuredClone(value));
      super.set(key, structuredClone(value));
    }
    if (this.size > CACHE_ENTRIES) throw new Error("indexed driver cache requires a fenced history import");
  }

  override get(key: string): T | undefined {
    if (super.has(key)) return super.get(key);
    if (key === "" || this.#absent.has(key)) return undefined;
    throw new Error(`indexed driver ${this.collection} lookup requires an exact receipt read`);
  }

  override has(key: string): boolean { return this.get(key) !== undefined; }

  override set(key: string, value: T): this {
    this.#absent.delete(key);
    this.#dirty.set(key, structuredClone(value));
    super.delete(key);
    super.set(key, value);
    this.#trim();
    return this;
  }

  override clear(): void {
    super.clear();
    this.#absent.clear();
    this.#dirty.clear();
  }

  #trim(): void {
    while (this.size > CACHE_ENTRIES) super.delete(super.keys().next().value!);
    while (this.#absent.size > CACHE_ENTRIES) this.#absent.delete(this.#absent.values().next().value!);
  }

  async prefetch(keys: Iterable<string>): Promise<void> {
    const requested = [...new Set(keys)].filter(Boolean);
    if (requested.length > CACHE_ENTRIES) throw new Error("storage_pressure: driver receipt lookup batch exceeds capacity");
    for (const key of requested) {
      if (super.has(key)) { const value = super.get(key)!; super.delete(key); super.set(key, value); continue; }
      if (this.#absent.has(key)) { this.#absent.delete(key); this.#absent.add(key); continue; }
      const value = await this.history.get(this.collection, key);
      if (value === null) this.#absent.add(key);
      else super.set(key, this.decode(structuredClone(value)));
      this.#trim();
    }
  }

  takeReceipts(): DriverHistoryReceipt[] {
    const receipts = [...this.#dirty].map(([key, value]) => ({ collection: this.collection, key, value: this.encode(value) }));
    this.#dirty.clear();
    return receipts;
  }
}

export class CodexHistorySet implements Iterable<string> {
  readonly map: CodexHistoryMap<boolean>;
  constructor(history: NonNullable<NormalizedDeliveryPort["history"]>, entries: Iterable<string>, restored: boolean) {
    this.map = new CodexHistoryMap<boolean>("file", history, [...entries].map((key) => [key, true]), restored);
  }
  has(key: string): boolean { return this.map.has(key); }
  add(key: string): this { this.map.set(key, true); return this; }
  clear(): void { this.map.clear(); }
  [Symbol.iterator](): IterableIterator<string> { return this.map.keys(); }
}
