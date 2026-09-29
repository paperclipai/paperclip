import type { AuthorityLocation } from "./authority-locator.js";
/** The execution store is independent of the server and its database driver.
 * History is queried by exact identity or cursor, never returned by load(). */
export const INDEXED_DURABILITY_CAPABILITY = "durability.indexed_state.v1";
/** Compatibility readers and writers must admit the same legacy journal size. */
export const MAX_LEGACY_AUTHORITY_STATE_BYTES = 192 * 1024 * 1024;
export const MAX_AUTHORITY_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_AUTHORITY_RECORD_BYTES = 1024 * 1024;
export const MAX_AUTHORITY_COMMIT_RECORDS = 512;

export interface AuthoritySnapshot {
  /** Exact store revision. Compare equality; never order or increment it. */
  generation: string;
  /** Exact predecessor when the store uses opaque commit identities. */
  committedFrom?: string;
  state: Record<string, unknown>;
}

export interface AuthorityRecord {
  epoch: string;
  kind: "command" | "event" | "effect";
  id: string;
  /** Command/event order belongs to the authenticated run epoch. Effects are
   * addressed by exact identity and use zero when the store supports it. */
  sequence: string;
  /** Absent is the retained numeric namespace; epochs require store capability. */
  sequenceEpoch?: string;
  body: Record<string, unknown>;
}

export interface AuthorityCommit {
  expectedGeneration: string;
  state: Record<string, unknown>;
  /** Newly settled receipts/events only. Existing records are immutable. */
  records: readonly AuthorityRecord[];
  work?: readonly AuthorityWorkChange[];
}

export interface AuthorityWorkRecord {
  collection: "process-owner";
  id: string;
  body: Record<string, unknown>;
  sha256: string;
}
export interface AuthorityWorkChange {
  collection: AuthorityWorkRecord["collection"];
  id: string;
  expectedSha256: string | null;
  /** Null retires current work; its exact retirement proof belongs in records. */
  body: Record<string, unknown> | null;
}
export interface AuthorityWorkPage { records: AuthorityWorkRecord[]; nextAfter: string | null }

export interface AuthorityPage {
  records: AuthorityRecord[];
  nextAfter: string | null;
}

export interface DurableAuthorityStore {
  readonly binding: string;
  readonly location: AuthorityLocation;
  /** Retained v1 stores require a positive ordered effect sequence. */
  readonly unorderedEffectReceipts?: boolean;
  readonly commandEpochs?: boolean;
  readonly eventEpochs?: boolean;
  load(): Promise<AuthoritySnapshot | null>;
  commit(input: AuthorityCommit): Promise<string>;
  getRecord(epoch: string, kind: AuthorityRecord["kind"], id: string): Promise<AuthorityRecord | null>;
  /** Session-scoped exact effect lookup survives run/authority rotation. */
  getSessionEffect(id: string): Promise<AuthorityRecord | null>;
  getWork(collection: AuthorityWorkRecord["collection"], id: string): Promise<AuthorityWorkRecord | null>;
  readWorkPage(collection: AuthorityWorkRecord["collection"], after: string, limit: number, expectedGeneration: string): Promise<AuthorityWorkPage>;
  readEvents(epoch: string, after: string, limit: number, byteBudget: number, sequenceEpoch?: string): Promise<AuthorityPage>;
  close(): Promise<void>;
}

export class DurableAuthorityStoreError extends Error {
  readonly code: "storage_pressure" | "storage_unavailable" | "stale_authority" | "receipt_conflict" | "invalid_authority";
  constructor(code: DurableAuthorityStoreError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "DurableAuthorityStoreError";
    this.code = code;
  }
}

export function authorityInteger(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new DurableAuthorityStoreError("invalid_authority", "invalid exact sequence/generation");
  }
  return BigInt(value);
}

/** Legacy stores expose exact integer revisions. Stores with opaque revisions
 * retain predecessor evidence for operations which must prove one transition. */
export function authorityGeneration(value: string): string {
  if (/^r:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) return value;
  authorityInteger(value);
  return value;
}

export function authorityDirectlyFollows(snapshot: AuthoritySnapshot, previous: string): boolean {
  authorityGeneration(previous);
  authorityGeneration(snapshot.generation);
  if (snapshot.committedFrom !== undefined) {
    authorityGeneration(snapshot.committedFrom);
    return snapshot.committedFrom === previous && snapshot.generation !== previous;
  }
  // Numeric v1 stores have no revision wraparound and prove their predecessor
  // by exact arithmetic. An opaque revision without a commit stamp cannot.
  if (snapshot.generation.startsWith("r:") || previous.startsWith("r:")) return false;
  return authorityInteger(snapshot.generation) === authorityInteger(previous) + 1n;
}

/** Stable encoding for receipt comparison across SQLite and Postgres. */
export function authorityJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(value: unknown, depth: number): string {
    if (depth > 128) throw new DurableAuthorityStoreError("invalid_authority", "authority JSON nesting exceeds 128");
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== "object" || value === null || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
      throw new DurableAuthorityStoreError("invalid_authority", "authority requires JSON values");
    }
    if (ancestors.has(value)) throw new DurableAuthorityStoreError("invalid_authority", "cyclic authority JSON");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return `[${value.map((item) => encode(item, depth + 1)).join(",")}]`;
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  return encode(value, 0);
}

export function validateAuthorityCommit(input: AuthorityCommit): void {
  authorityGeneration(input.expectedGeneration);
  if (Buffer.byteLength(authorityJson(input.state)) > MAX_AUTHORITY_STATE_BYTES || input.records.length > MAX_AUTHORITY_COMMIT_RECORDS) {
    throw new DurableAuthorityStoreError("storage_pressure", "current state or commit exceeds admission capacity");
  }
  let bytes = 0;
  for (const record of input.records) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(record.epoch) || !["command", "event", "effect"].includes(record.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(record.id) || (authorityInteger(record.sequence) === 0n && record.kind !== "effect")) {
      throw new DurableAuthorityStoreError("invalid_authority", "invalid receipt identity");
    }
    if (record.sequenceEpoch !== undefined && (record.kind === "effect" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.sequenceEpoch))) {
      throw new DurableAuthorityStoreError("invalid_authority", "invalid receipt sequence epoch");
    }
    const size = Buffer.byteLength(authorityJson(record.body));
    bytes += size;
    if (size > MAX_AUTHORITY_RECORD_BYTES || bytes > MAX_AUTHORITY_STATE_BYTES) {
      throw new DurableAuthorityStoreError("storage_pressure", "receipt transaction exceeds admission capacity");
    }
  }
  const changes = input.work ?? [];
  if (changes.length > 128) throw new DurableAuthorityStoreError("storage_pressure", "outstanding-work transaction exceeds capacity");
  const keys = new Set<string>();
  for (const change of changes) {
    validateAuthorityWorkKey(change.collection, change.id);
    const key = `${change.collection}:${change.id}`;
    if (keys.has(key) || (change.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(change.expectedSha256)) ||
      (change.body !== null && Buffer.byteLength(authorityJson(change.body)) > 16384)) throw new DurableAuthorityStoreError("invalid_authority", "invalid outstanding-work mutation");
    keys.add(key);
  }
}

export function validateAuthorityWorkKey(collection: string, id: string): void {
  if (collection !== "process-owner" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(id)) throw new DurableAuthorityStoreError("invalid_authority", "invalid outstanding-work identity");
}
export function validateAuthorityWorkPage(collection: string, after: string, limit: number, generation: string): void {
  validateAuthorityWorkKey(collection, after || "first"); authorityGeneration(generation);
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new DurableAuthorityStoreError("invalid_authority", "invalid outstanding-work page");
}

export function validateAuthorityPage(after: string, limit: number, byteBudget: number, sequenceEpoch?: string): void {
  authorityInteger(after);
  if (sequenceEpoch !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(sequenceEpoch)) throw new DurableAuthorityStoreError("invalid_authority", "invalid event page namespace");
  if (!Number.isInteger(limit) || limit < 1 || limit > 128 || !Number.isInteger(byteBudget) || byteBudget < MAX_AUTHORITY_RECORD_BYTES || byteBudget > MAX_AUTHORITY_STATE_BYTES) {
    throw new DurableAuthorityStoreError("invalid_authority", "invalid event page capacity");
  }
}
