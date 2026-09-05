import { createHash, randomUUID } from "node:crypto";
import type { Lock, QueueEntry, StateAdapter } from "chat";

const STATE_SCHEMA_VERSION = 1;
const DEFAULT_MAX_VALUE_BYTES = 1024 * 1024;
const MAX_LOGICAL_KEY_LENGTH = 8192;
const MAX_SCOPE_ID_LENGTH = 512;
const MAX_CAS_ATTEMPTS = 32;

type StateKind = "cache" | "list" | "lock" | "queue" | "subscription";

/** Company + endpoint boundary applied to every Chat SDK state operation. */
export interface ChatSdkStateScope {
  companyId: string;
  endpointId: string;
}

/** A versioned row returned by the Paperclip persistence implementation. */
export interface ChatSdkStateRecord {
  expiresAt: Date | null;
  value: unknown;
  version: number;
}

export interface ChatSdkStateCompareAndSetInput extends ChatSdkStateScope {
  /** null means create only when the row does not exist. */
  expectedVersion: number | null;
  expiresAt: Date | null;
  key: string;
  value: unknown;
}

export interface ChatSdkStateDeleteInput extends ChatSdkStateScope {
  expectedVersion: number;
  key: string;
}

/**
 * Narrow database port used by the Chat SDK adapter.
 *
 * The production implementation is responsible for company scoping and for
 * making compare-and-set/delete atomic in the database transaction. Keeping
 * those two primitives below this adapter lets every higher-level Chat SDK
 * operation (locks, queues, subscriptions, lists, and cache entries) share the
 * same first-party `chat_sdk_state` storage without depending on Drizzle here.
 */
export interface ChatSdkStatePersistence {
  compareAndSet(input: ChatSdkStateCompareAndSetInput): Promise<boolean>;
  deleteIfVersion(input: ChatSdkStateDeleteInput): Promise<boolean>;
  read(
    scope: ChatSdkStateScope,
    key: string,
  ): Promise<ChatSdkStateRecord | null>;
}

interface StateEnvelope {
  kind: StateKind;
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  value: unknown;
}

export interface PaperclipChatSdkStateOptions extends ChatSdkStateScope {
  maxValueBytes?: number;
  now?: () => Date;
  persistence: ChatSdkStatePersistence;
}

function assertBoundedIdentifier(
  label: string,
  value: string,
  maximum: number,
): void {
  if (!value || value.length > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} characters`);
  }
}

function assertTtl(label: string, ttlMs: number): void {
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function storageKey(kind: StateKind, logicalKey: string): string {
  assertBoundedIdentifier(
    "Chat SDK state key",
    logicalKey,
    MAX_LOGICAL_KEY_LENGTH,
  );
  const digest = createHash("sha256").update(logicalKey).digest("hex");
  return `${kind}:${digest}`;
}

function decodeEnvelope(
  record: ChatSdkStateRecord,
  expectedKind: StateKind,
): unknown {
  const envelope = record.value as Partial<StateEnvelope> | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.schemaVersion !== STATE_SCHEMA_VERSION ||
    envelope.kind !== expectedKind ||
    !("value" in envelope)
  ) {
    throw new Error(
      `Invalid Chat SDK state envelope for ${expectedKind} (record version ${record.version})`,
    );
  }
  return envelope.value;
}

/**
 * Chat SDK StateAdapter backed by Paperclip's injected, company-scoped CAS
 * persistence. Instances are endpoint-scoped and never own or close the shared
 * database connection.
 */
export class PaperclipChatSdkStateAdapter implements StateAdapter {
  private readonly scope: ChatSdkStateScope;
  private readonly persistence: ChatSdkStatePersistence;
  private readonly now: () => Date;
  private readonly maxValueBytes: number;
  private connected = false;

  constructor(options: PaperclipChatSdkStateOptions) {
    assertBoundedIdentifier(
      "companyId",
      options.companyId,
      MAX_SCOPE_ID_LENGTH,
    );
    assertBoundedIdentifier(
      "endpointId",
      options.endpointId,
      MAX_SCOPE_ID_LENGTH,
    );
    this.scope = {
      companyId: options.companyId,
      endpointId: options.endpointId,
    };
    this.persistence = options.persistence;
    this.now = options.now ?? (() => new Date());
    this.maxValueBytes = options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES;
    if (!(Number.isSafeInteger(this.maxValueBytes) && this.maxValueBytes > 0)) {
      throw new Error("maxValueBytes must be a positive safe integer");
    }
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    await this.write("subscription", threadId, true, null);
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.deleteCurrent("subscription", threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const current = await this.readLive("subscription", threadId);
    if (!current) return false;
    if (current.value !== true) {
      throw new Error("Invalid Chat SDK subscription state");
    }
    return true;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    assertTtl("Lock TTL", ttlMs);
    const key = storageKey("lock", threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (record && !this.isExpired(record)) return null;
      const expiresAt = this.now().getTime() + ttlMs;
      const lock: Lock = { threadId, token: randomUUID(), expiresAt };
      const written = await this.compareAndSet(
        key,
        record?.version ?? null,
        "lock",
        lock,
        new Date(expiresAt),
      );
      if (written) return lock;
    }
    throw this.casExhausted("acquire lock");
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    assertTtl("Lock TTL", ttlMs);
    const key = storageKey("lock", lock.threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record || this.isExpired(record)) return false;
      const current = decodeEnvelope(record, "lock") as Partial<Lock>;
      if (current.token !== lock.token || current.threadId !== lock.threadId)
        return false;
      const expiresAt = this.now().getTime() + ttlMs;
      const extended: Lock = { ...lock, expiresAt };
      if (
        await this.compareAndSet(
          key,
          record.version,
          "lock",
          extended,
          new Date(expiresAt),
        )
      ) {
        return true;
      }
    }
    throw this.casExhausted("extend lock");
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    const key = storageKey("lock", lock.threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record) return;
      if (this.isExpired(record)) {
        await this.persistence.deleteIfVersion({
          ...this.scope,
          key,
          expectedVersion: record.version,
        });
        return;
      }
      const current = decodeEnvelope(record, "lock") as Partial<Lock>;
      if (current.token !== lock.token) return;
      if (
        await this.persistence.deleteIfVersion({
          ...this.scope,
          key,
          expectedVersion: record.version,
        })
      ) {
        return;
      }
    }
    throw this.casExhausted("release lock");
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.deleteCurrent("lock", threadId);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const current = await this.readLive("cache", key);
    return current ? (current.value as T) : null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.write("cache", key, value, this.expiryFromTtl(ttlMs));
  }

  async setIfNotExists(
    key: string,
    value: unknown,
    ttlMs?: number,
  ): Promise<boolean> {
    this.ensureConnected();
    const storedKey = storageKey("cache", key);
    const expiresAt = this.expiryFromTtl(ttlMs);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, storedKey);
      if (record && !this.isExpired(record)) return false;
      if (
        await this.compareAndSet(
          storedKey,
          record?.version ?? null,
          "cache",
          value,
          expiresAt,
        )
      ) {
        return true;
      }
    }
    throw this.casExhausted("set cache value if absent");
  }

  async delete(key: string): Promise<void> {
    await this.deleteCurrent("cache", key);
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    this.ensureConnected();
    if (
      options?.maxLength !== undefined &&
      !(Number.isSafeInteger(options.maxLength) && options.maxLength > 0)
    ) {
      throw new Error("List maxLength must be a positive safe integer");
    }
    const storedKey = storageKey("list", key);
    const expiresAt = this.expiryFromTtl(options?.ttlMs);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, storedKey);
      const prior =
        record && !this.isExpired(record) ? decodeEnvelope(record, "list") : [];
      if (!Array.isArray(prior)) throw new Error("Invalid Chat SDK list state");
      const appended = [...prior, value];
      const next = options?.maxLength
        ? appended.slice(-options.maxLength)
        : appended;
      if (
        await this.compareAndSet(
          storedKey,
          record?.version ?? null,
          "list",
          next,
          expiresAt,
        )
      ) {
        return;
      }
    }
    throw this.casExhausted("append list value");
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const current = await this.readLive("list", key);
    if (!current) return [];
    if (!Array.isArray(current.value))
      throw new Error("Invalid Chat SDK list state");
    return current.value as T[];
  }

  async enqueue(
    threadId: string,
    entry: QueueEntry,
    maxSize: number,
  ): Promise<number> {
    this.ensureConnected();
    if (!(Number.isSafeInteger(maxSize) && maxSize > 0)) {
      throw new Error("Queue maxSize must be a positive safe integer");
    }
    const key = storageKey("queue", threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      const prior =
        record && !this.isExpired(record)
          ? decodeEnvelope(record, "queue")
          : [];
      if (!Array.isArray(prior))
        throw new Error("Invalid Chat SDK queue state");
      const now = this.now().getTime();
      const live = (prior as QueueEntry[]).filter(
        (item) => item.expiresAt > now,
      );
      const next = [...live, entry].slice(-maxSize);
      const expiresAt = new Date(
        Math.max(...next.map((item) => item.expiresAt)),
      );
      if (
        await this.compareAndSet(
          key,
          record?.version ?? null,
          "queue",
          next,
          expiresAt,
        )
      ) {
        return next.length;
      }
    }
    throw this.casExhausted("enqueue message");
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected();
    const key = storageKey("queue", threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record) return null;
      if (this.isExpired(record)) {
        if (
          await this.persistence.deleteIfVersion({
            ...this.scope,
            key,
            expectedVersion: record.version,
          })
        )
          return null;
        continue;
      }
      const value = decodeEnvelope(record, "queue");
      if (!Array.isArray(value))
        throw new Error("Invalid Chat SDK queue state");
      const now = this.now().getTime();
      const live = (value as QueueEntry[]).filter(
        (item) => item.expiresAt > now,
      );
      const entry = live.shift() ?? null;
      const changed = live.length !== value.length;
      if (!entry && !changed) return null;
      const updated =
        live.length > 0
          ? await this.compareAndSet(
              key,
              record.version,
              "queue",
              live,
              new Date(Math.max(...live.map((item) => item.expiresAt))),
            )
          : await this.persistence.deleteIfVersion({
              ...this.scope,
              key,
              expectedVersion: record.version,
            });
      if (updated) return entry;
    }
    throw this.casExhausted("dequeue message");
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected();
    const key = storageKey("queue", threadId);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record) return 0;
      if (this.isExpired(record)) {
        if (
          await this.persistence.deleteIfVersion({
            ...this.scope,
            key,
            expectedVersion: record.version,
          })
        )
          return 0;
        continue;
      }
      const value = decodeEnvelope(record, "queue");
      if (!Array.isArray(value))
        throw new Error("Invalid Chat SDK queue state");
      const now = this.now().getTime();
      const live = (value as QueueEntry[]).filter(
        (item) => item.expiresAt > now,
      );
      if (live.length === value.length) return live.length;
      const updated =
        live.length > 0
          ? await this.compareAndSet(
              key,
              record.version,
              "queue",
              live,
              new Date(Math.max(...live.map((item) => item.expiresAt))),
            )
          : await this.persistence.deleteIfVersion({
              ...this.scope,
              key,
              expectedVersion: record.version,
            });
      if (updated) return live.length;
    }
    throw this.casExhausted("read queue depth");
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error(
        "PaperclipChatSdkStateAdapter is not connected. Call connect() first.",
      );
    }
  }

  private isExpired(record: ChatSdkStateRecord): boolean {
    return (
      record.expiresAt !== null &&
      record.expiresAt.getTime() <= this.now().getTime()
    );
  }

  private expiryFromTtl(ttlMs: number | undefined): Date | null {
    if (ttlMs === undefined || ttlMs === 0) return null;
    assertTtl("State TTL", ttlMs);
    return new Date(this.now().getTime() + ttlMs);
  }

  private envelope(kind: StateKind, value: unknown): StateEnvelope {
    const envelope: StateEnvelope = {
      kind,
      schemaVersion: STATE_SCHEMA_VERSION,
      value,
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      throw new Error(`Chat SDK ${kind} state is not JSON-serializable`, {
        cause: error,
      });
    }
    if (Buffer.byteLength(serialized) > this.maxValueBytes) {
      throw new Error(
        `Chat SDK ${kind} state exceeds the ${this.maxValueBytes}-byte limit`,
      );
    }
    return envelope;
  }

  private async compareAndSet(
    key: string,
    expectedVersion: number | null,
    kind: StateKind,
    value: unknown,
    expiresAt: Date | null,
  ): Promise<boolean> {
    return this.persistence.compareAndSet({
      ...this.scope,
      key,
      expectedVersion,
      expiresAt,
      value: this.envelope(kind, value),
    });
  }

  private async readLive(
    kind: StateKind,
    logicalKey: string,
  ): Promise<{ value: unknown } | null> {
    this.ensureConnected();
    const key = storageKey(kind, logicalKey);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record) return null;
      if (!this.isExpired(record))
        return { value: decodeEnvelope(record, kind) };
      if (
        await this.persistence.deleteIfVersion({
          ...this.scope,
          key,
          expectedVersion: record.version,
        })
      ) {
        return null;
      }
    }
    throw this.casExhausted(`read ${kind} state`);
  }

  private async write(
    kind: StateKind,
    logicalKey: string,
    value: unknown,
    expiresAt: Date | null,
  ): Promise<void> {
    this.ensureConnected();
    const key = storageKey(kind, logicalKey);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (
        await this.compareAndSet(
          key,
          record?.version ?? null,
          kind,
          value,
          expiresAt,
        )
      )
        return;
    }
    throw this.casExhausted(`write ${kind} state`);
  }

  private async deleteCurrent(
    kind: StateKind,
    logicalKey: string,
  ): Promise<void> {
    this.ensureConnected();
    const key = storageKey(kind, logicalKey);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const record = await this.persistence.read(this.scope, key);
      if (!record) return;
      if (
        await this.persistence.deleteIfVersion({
          ...this.scope,
          key,
          expectedVersion: record.version,
        })
      )
        return;
    }
    throw this.casExhausted(`delete ${kind} state`);
  }

  private casExhausted(operation: string): Error {
    return new Error(
      `Could not ${operation} after ${MAX_CAS_ATTEMPTS} concurrent state changes`,
    );
  }
}

export function createPaperclipChatSdkState(
  options: PaperclipChatSdkStateOptions,
): PaperclipChatSdkStateAdapter {
  return new PaperclipChatSdkStateAdapter(options);
}
