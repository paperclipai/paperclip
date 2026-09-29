import { isCommandEpoch } from "./command-epochs.js";
import { advanceSourceCursor, isEventEpochTransition, type EventEpochTransition, type SourceCursor } from "./event-epochs.js";
import { randomUUID } from "node:crypto";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { validatePrpEvent } from "../protocol/replay-contract.js";
import { authorityGeneration, authorityJson, DurableAuthorityStoreError } from "./durable-authority-store.js";

/** A raw frame can expand into several driver notifications. This cursor is
 * independent of both the runner ACK and the normalized run-log sequence. */
export interface RawDeliveryCursor { epoch: string; sourceEpoch?: string; sourceSeq: number; ordinal: number }
export const RAW_DELIVERY_FRAME_COMPLETE = Number.MAX_SAFE_INTEGER;
/** Retained checkpoints use safe integers. New revisions are equality-only
 * identities, independent of raw and normalized event ordering. */
export type NormalizedDeliveryRevision = number | string;

export interface NormalizedDeliveryState {
  schema: "paperclip.runner.normalized-delivery.v1";
  revision: NormalizedDeliveryRevision;
  raw: RawDeliveryCursor;
  driver: Record<string, unknown>;
  produced: number;
  producedEpoch?: string;
  acknowledged: number;
  acknowledgedEpoch?: string;
  lastSourceEpochTransition?: EventEpochTransition;
  /** Only outstanding delivery, never completed history. */
  pending: PrpEvent[];
}

export interface NormalizedDeliveryBatch {
  expectedRevision: NormalizedDeliveryRevision;
  raw: RawDeliveryCursor;
  driver: Record<string, unknown>;
  events: PrpEvent[];
  receipts?: DriverHistoryReceipt[];
}

export type DriverHistoryCollection = "terminal" | "file" | "steering" | "lineage";
export interface DriverHistoryReceipt {
  collection: DriverHistoryCollection;
  key: string;
  value: unknown;
}

export interface NormalizedDeliveryPort {
  readonly epoch: string;
  readonly eventEpochs?: { limit: number };
  load(): NormalizedDeliveryState | null;
  commit(batch: NormalizedDeliveryBatch): Promise<NormalizedDeliveryState>;
  acknowledge(event: PrpEvent): Promise<void>;
  history?: { get(collection: DriverHistoryCollection, key: string): Promise<unknown | null> };
}

export const MAX_NORMALIZED_PENDING_EVENTS = 256;
export const MAX_NORMALIZED_PENDING_BYTES = 4 * 1024 * 1024;

function invalid(message: string): never {
  throw new DurableAuthorityStoreError("invalid_authority", `normalized delivery: ${message}`);
}

export function compareRawCursor(a: RawDeliveryCursor, b: RawDeliveryCursor): number {
  if (a.epoch !== b.epoch || a.sourceEpoch !== b.sourceEpoch) invalid("raw cursor namespaces cannot be numerically compared");
  return a.sourceSeq - b.sourceSeq || a.ordinal - b.ordinal;
}

export function validateNormalizedDelivery(value: NormalizedDeliveryState): void {
  if (typeof value.revision === "number") {
    if (!Number.isSafeInteger(value.revision) || value.revision < 0) invalid("invalid checkpoint revision");
  } else if (typeof value.revision !== "string" || !value.revision.startsWith("r:")) invalid("invalid checkpoint revision");
  else authorityGeneration(value.revision);
  if (value.schema !== "paperclip.runner.normalized-delivery.v1"
    || typeof value.raw?.epoch !== "string" || !value.raw.epoch || value.raw.epoch.length > 240
    || (value.raw.sourceEpoch !== undefined && !isCommandEpoch(value.raw.sourceEpoch))
    || ![value.raw?.sourceSeq, value.raw?.ordinal, value.produced, value.acknowledged].every((n) => Number.isSafeInteger(n) && n >= 0)
    || (value.producedEpoch !== undefined && !isCommandEpoch(value.producedEpoch))
    || (value.acknowledgedEpoch !== undefined && !isCommandEpoch(value.acknowledgedEpoch))
    || !Array.isArray(value.pending)
    || !value.driver || typeof value.driver !== "object" || Array.isArray(value.driver)) invalid("invalid checkpoint");
  if (value.pending.length > MAX_NORMALIZED_PENDING_EVENTS || Buffer.byteLength(authorityJson(value.pending)) > MAX_NORMALIZED_PENDING_BYTES) {
    throw new DurableAuthorityStoreError("storage_pressure", "normalized delivery awaiting run-log acknowledgement");
  }
  if (value.producedEpoch !== undefined || value.lastSourceEpochTransition !== undefined) {
    const t = value.lastSourceEpochTransition;
    if (!isEventEpochTransition(t) || t.nextEpoch !== value.producedEpoch || t.runId !== value.raw.epoch) invalid("invalid normalized head receipt");
  }
  let cursor: SourceCursor = { sourceEpoch: value.acknowledgedEpoch, sourceSeq: value.acknowledged };
  for (const event of value.pending) {
    if (!validatePrpEvent(event).ok || event.runId !== value.raw.epoch) invalid("invalid pending event");
    try { cursor = advanceSourceCursor(cursor, event); } catch { invalid("pending event sequence is not contiguous"); }
  }
  if (cursor.sourceSeq !== value.produced || cursor.sourceEpoch !== value.producedEpoch) invalid("missing pending event");
}

/** Build a candidate without changing published state. The owner commits it
 * with the raw cursor and only then exposes its events to the consumer. */
export function applyNormalizedBatch(previous: NormalizedDeliveryState | null, batch: NormalizedDeliveryBatch, rawTransition?: EventEpochTransition): NormalizedDeliveryState {
  if (previous) validateNormalizedDelivery(previous);
  if (batch.expectedRevision !== (previous?.revision ?? 0)) {
    throw new DurableAuthorityStoreError("stale_authority", "normalized consumer revision changed");
  }
  if (previous && batch.raw.epoch !== previous.raw.epoch) invalid("raw cursor belongs to another run epoch");
  const crossing = previous?.raw.sourceEpoch !== batch.raw.sourceEpoch;
  if (crossing) {
    if (!previous || !isEventEpochTransition(rawTransition) || rawTransition.runId !== batch.raw.epoch
      || rawTransition.fromEpoch !== (previous.raw.sourceEpoch ?? null) || rawTransition.nextEpoch !== batch.raw.sourceEpoch
      || previous.raw.sourceSeq !== rawTransition.finalOrdinal || previous.raw.ordinal !== RAW_DELIVERY_FRAME_COMPLETE
      || batch.raw.sourceSeq !== 0 || batch.raw.ordinal !== 0 || batch.events.length !== 0) invalid("raw epoch boundary has no exact consumed predecessor");
  }
  if (!crossing && compareRawCursor(batch.raw, previous?.raw ?? { epoch: batch.raw.epoch, sourceSeq: 0, ordinal: 0 }) < 0) invalid(`raw cursor moved backwards (${previous!.raw.sourceSeq}:${previous!.raw.ordinal} -> ${batch.raw.sourceSeq}:${batch.raw.ordinal})`);
  const initialSequence = previous?.produced ?? (batch.events[0]?.sourceSeq ?? 1) - 1;
  let cursor: SourceCursor = { sourceSeq: initialSequence, sourceEpoch: previous?.producedEpoch };
  let lastTransition = previous?.lastSourceEpochTransition;
  for (const event of batch.events) {
    try { cursor = advanceSourceCursor(cursor, event); } catch { invalid("produced event sequence is not contiguous"); }
    if (event.sourceEpochTransition) lastTransition = event.sourceEpochTransition;
  }
  const state: NormalizedDeliveryState = {
    schema: "paperclip.runner.normalized-delivery.v1",
    revision: `r:${randomUUID()}`,
    raw: structuredClone(batch.raw),
    driver: structuredClone(batch.driver),
    produced: cursor.sourceSeq,
    ...(cursor.sourceEpoch ? { producedEpoch: cursor.sourceEpoch } : {}),
    ...(previous?.acknowledgedEpoch ? { acknowledgedEpoch: previous.acknowledgedEpoch } : {}),
    ...(lastTransition ? { lastSourceEpochTransition: structuredClone(lastTransition) } : {}),
    acknowledged: previous?.acknowledged ?? initialSequence,
    pending: [...(previous?.pending ?? []), ...structuredClone(batch.events)],
  };
  validateNormalizedDelivery(state);
  return state;
}

/** ACKs are accepted only for the exact next event, after the run-log writer
 * reports durable success. A crash before this commit replays identical bytes. */
export function acknowledgeNormalizedEvent(previous: NormalizedDeliveryState, event: PrpEvent): NormalizedDeliveryState {
  const next = previous.pending[0];
  if (!next || authorityJson(next) !== authorityJson(event)) invalid("run-log acknowledgement differs from pending event");
  const state = { ...previous, acknowledged: event.sourceSeq, pending: previous.pending.slice(1) };
  if (event.sourceEpoch) state.acknowledgedEpoch = event.sourceEpoch;
  else delete state.acknowledgedEpoch;
  validateNormalizedDelivery(state);
  return state;
}
