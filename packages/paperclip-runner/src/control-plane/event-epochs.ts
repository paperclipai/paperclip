import { createHash } from "node:crypto";
import { isCommandEpoch } from "./command-epochs.js";
export const EVENT_EPOCH_CAPABILITY = "transport.event_epochs.v1";
export const EVENT_EPOCH_LIMIT = 1_048_576;
/** The sender drains its durable outbox before installing this successor. */
export interface EventEpochTransition {
  schema: "paperclip.prp.event-epoch.v1";
  runId: string;
  transitionId: string;
  fromEpoch: string | null;
  nextEpoch: string;
  finalOrdinal: number;
}
export interface EventResume {
  sourceEpoch: string | null;
  nextSourceEventSeq: number;
  ackedSourceSeq: number;
  transition: EventEpochTransition | null;
}
export function isEventEpochTransition(value: unknown): value is EventEpochTransition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as EventEpochTransition;
  return Object.keys(v).length === 6 && v.schema === "paperclip.prp.event-epoch.v1"
    && typeof v.runId === "string" && v.runId.length > 0 && v.runId.length <= 240
    && isCommandEpoch(v.transitionId) && (v.fromEpoch === null || isCommandEpoch(v.fromEpoch))
    && isCommandEpoch(v.nextEpoch) && v.nextEpoch !== v.fromEpoch
    && Number.isSafeInteger(v.finalOrdinal) && v.finalOrdinal > 0;
}
export function isEventResume(value: unknown): value is EventResume {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as EventResume;
  return Object.keys(v).length === 4 && (v.sourceEpoch === null || isCommandEpoch(v.sourceEpoch))
    && Number.isSafeInteger(v.nextSourceEventSeq) && v.nextSourceEventSeq > 0
    && Number.isSafeInteger(v.ackedSourceSeq) && v.ackedSourceSeq >= 0 && v.ackedSourceSeq < v.nextSourceEventSeq
    && (v.transition === null || (isEventEpochTransition(v.transition) && v.transition.fromEpoch === v.sourceEpoch && v.transition.finalOrdinal === v.nextSourceEventSeq - 1));
}
export function eventEpochCloseId(transition: Pick<EventEpochTransition, "runId" | "fromEpoch">): string {
  return `event-epoch-from-${createHash("sha256").update(JSON.stringify([transition.runId, transition.fromEpoch])).digest("hex")}`;
}
export function compareCurrentEvents(a: { sourceEpoch?: string; sourceSeq: number }, b: { sourceEpoch?: string; sourceSeq: number }, epoch: string | undefined): number {
  if (a.sourceEpoch === b.sourceEpoch) return a.sourceSeq - b.sourceSeq;
  return Number(a.sourceEpoch === epoch) - Number(b.sourceEpoch === epoch);
}

/** The normalized outbox commits this boundary with its first successor event.
 * These identities never depend on a lifetime ordinal. */
export function normalizedEpochCloseId(runId: string, sourceInstanceId: string, fromEpoch: string | null): string {
  return `normalized-epoch-from-${createHash("sha256").update(JSON.stringify([runId, sourceInstanceId, fromEpoch])).digest("hex")}`;
}
export function normalizedEventId(sourceInstanceId: string, runId: string, sourceSeq: number, sourceEpoch?: string): string {
  return sourceEpoch === undefined ? `${sourceInstanceId}:${runId}:${sourceSeq}`
    : `normalized-${createHash("sha256").update(JSON.stringify([sourceInstanceId, runId, sourceEpoch, sourceSeq])).digest("hex")}`;
}
export interface SourceCursor { sourceEpoch?: string; sourceSeq: number }
/** Only a verified predecessor and an explicit first-event receipt can cross
 * namespaces. Numeric ordering is meaningful inside one namespace only. */
export function advanceSourceCursor(previous: SourceCursor, event: SourceCursor & { runId: string; sourceEpochTransition?: EventEpochTransition }): SourceCursor {
  if (!Number.isSafeInteger(previous.sourceSeq) || previous.sourceSeq < 0 || !Number.isSafeInteger(event.sourceSeq) || event.sourceSeq < 1
    || (previous.sourceEpoch !== undefined && !isCommandEpoch(previous.sourceEpoch))
    || (event.sourceEpoch !== undefined && !isCommandEpoch(event.sourceEpoch))) throw new Error("invalid source cursor");
  if (previous.sourceEpoch === event.sourceEpoch) {
    if (event.sourceEpochTransition !== undefined || previous.sourceSeq === Number.MAX_SAFE_INTEGER || event.sourceSeq !== previous.sourceSeq + 1) throw new Error("source cursor is not contiguous");
  } else {
    const t = event.sourceEpochTransition;
    if (!isEventEpochTransition(t) || t.runId !== event.runId || t.fromEpoch !== (previous.sourceEpoch ?? null)
      || t.nextEpoch !== event.sourceEpoch || t.finalOrdinal !== previous.sourceSeq || event.sourceSeq !== 1) throw new Error("source epoch has no exact predecessor");
  }
  return { ...(event.sourceEpoch ? { sourceEpoch: event.sourceEpoch } : {}), sourceSeq: event.sourceSeq };
}

export function encodeSourceCursor(cursor: SourceCursor): string {
  if (!Number.isSafeInteger(cursor.sourceSeq) || cursor.sourceSeq < 0 || (cursor.sourceEpoch !== undefined && !isCommandEpoch(cursor.sourceEpoch))) throw new Error("invalid source cursor");
  return cursor.sourceEpoch ? `e:${cursor.sourceEpoch}:${cursor.sourceSeq}` : String(cursor.sourceSeq);
}
export function decodeSourceCursor(value: string | null | undefined): SourceCursor {
  if (value?.startsWith("e:")) {
    const match = /^e:([^:]+):(0|[1-9][0-9]*)$/.exec(value);
    if (!match || !isCommandEpoch(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error("invalid source cursor");
    return { sourceEpoch: match[1], sourceSeq: Number(match[2]) };
  }
  const sourceSeq = Number(value ?? 0);
  return { sourceSeq: Number.isSafeInteger(sourceSeq) && sourceSeq >= 0 ? sourceSeq : 0 };
}
