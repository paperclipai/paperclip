import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import {
  DurableAuthorityStoreError,
  validateAuthorityCommit,
  validateAuthorityPage,
  validateAuthorityWorkKey,
  validateAuthorityWorkPage,
  type AuthorityWorkRecord,
  type AuthorityWorkPage,
  type AuthorityCommit,
  type AuthorityPage,
  type AuthorityRecord,
  type AuthoritySnapshot,
  type DurableAuthorityStore,
} from "./durable-authority-store.js";

/** Standalone/eval implementation. Production Paperclip uses its Postgres
 * transaction so event acceptance and current authority share one commit. */
export class SqliteAuthorityStore implements DurableAuthorityStore {
  readonly location: import("./authority-locator.js").AuthorityLocation;
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #nextRequest = 0;
  #failure: Error | null = null;
  #closed = false;
  #unorderedEffectReceipts = false;
  #eventEpochs = false;
  get eventEpochs(): boolean { return this.#eventEpochs; }
  #commandEpochs = false;
  get commandEpochs(): boolean { return this.#commandEpochs; }

  get unorderedEffectReceipts(): boolean { return this.#unorderedEffectReceipts; }

  private constructor(readonly binding: string, path: string, create: boolean, readOnly = false, runnerBinary?: string) {
    this.location = { kind: "sqlite", binding, file: basename(path) };
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    this.#worker = new Worker(new URL(`./sqlite-authority-worker.${extension}`, import.meta.url), {
      workerData: { binding, path, create, readOnly, runnerBinary },
      // The worker is a plain Node module, never a Vitest/tsx loader copy.
      execArgv: [],
    });
    this.#worker.on("message", (message: { id: number; value?: unknown; error?: { code: DurableAuthorityStoreError["code"]; message: string } }) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new DurableAuthorityStoreError(message.error.code, message.error.message));
      else pending.resolve(message.value);
    });
    this.#worker.on("error", (error) => this.#fail(error));
    this.#worker.on("exit", (code) => {
      if (!this.#closed || this.#pending.size) this.#fail(new DurableAuthorityStoreError("storage_unavailable", `storage worker exited (${code})`));
    });
  }

  static async open(input: { binding: string; path: string; create: boolean; readOnly?: boolean; runnerBinary?: string }): Promise<SqliteAuthorityStore> {
    const store = new SqliteAuthorityStore(input.binding, input.path, input.create, input.readOnly, input.runnerBinary);
    try {
      const ready = await store.#request<{ unorderedEffectReceipts?: boolean; commandEpochs?: boolean; eventEpochs?: boolean } | null>("ready", {});
      store.#unorderedEffectReceipts = ready?.unorderedEffectReceipts === true;
      store.#commandEpochs = ready?.commandEpochs === true;
      store.#eventEpochs = ready?.eventEpochs === true;
      return store;
    }
    catch (error) { await store.#worker.terminate(); throw error; }
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
  }

  #request<T>(operation: string, input: unknown): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new DurableAuthorityStoreError("storage_unavailable", "store is closed"));
    if (this.#pending.size >= 8) return Promise.reject(new DurableAuthorityStoreError("storage_pressure", "storage executor queue is full"));
    // RPC correlation is local to the current bounded in-flight set, not a
    // durable history sequence. Reuse settled IDs instead of overflowing a
    // lifetime JavaScript counter in a continuously running storage worker.
    do { this.#nextRequest = this.#nextRequest >= 0xffff_ffff ? 1 : this.#nextRequest + 1; }
    while (this.#pending.has(this.#nextRequest));
    const id = this.#nextRequest;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { this.#worker.postMessage({ id, operation, input }); }
      catch (error) { this.#pending.delete(id); reject(error); }
    });
  }

  load(): Promise<AuthoritySnapshot | null> { return this.#request("load", {}); }

  commit(input: AuthorityCommit): Promise<string> {
    validateAuthorityCommit(input);
    return this.#request("commit", input);
  }

  getRecord(epoch: string, kind: AuthorityRecord["kind"], id: string): Promise<AuthorityRecord | null> {
    return this.#request("getRecord", { epoch, kind, id });
  }

  getSessionEffect(id: string): Promise<AuthorityRecord | null> {
    return this.#request("getSessionEffect", { id });
  }

  getWork(collection: AuthorityWorkRecord["collection"], id: string): Promise<AuthorityWorkRecord | null> {
    validateAuthorityWorkKey(collection, id);
    return this.#request("getWork", { collection, id });
  }

  readWorkPage(collection: AuthorityWorkRecord["collection"], after: string, limit: number, expectedGeneration: string): Promise<AuthorityWorkPage> {
    validateAuthorityWorkPage(collection, after, limit, expectedGeneration);
    return this.#request("readWorkPage", { collection, after, limit, expectedGeneration });
  }

  readEvents(epoch: string, after: string, limit: number, byteBudget: number, sequenceEpoch?: string): Promise<AuthorityPage> {
    validateAuthorityPage(after, limit, byteBudget, sequenceEpoch);
    if (sequenceEpoch !== undefined && !this.eventEpochs) return Promise.reject(new DurableAuthorityStoreError("invalid_authority", "event epochs require indexed storage"));
    return this.#request("readEvents", { epoch, after, limit, byteBudget, sequenceEpoch });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    try { await this.#request("close", {}); }
    finally { this.#closed = true; await this.#worker.terminate(); }
  }
}
