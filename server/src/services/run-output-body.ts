import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { heartbeatRunEvents, nativeOutputBodyChunks, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { createHistoryPayloadStore, type HistoryPayloadStore } from "./native-runtime/history-payload-store.js";
import type { AppendHeartbeatRunEventInput } from "./heartbeat-run-events.js";

// This bounds ONE admitted provider frame, never a run or its accumulated output.
export const MAX_RUN_OUTPUT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 - 2;
const hex = /^[a-f0-9]{64}$/;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Provider output is durable before its event transaction can acknowledge it.
 * Keep the original canonical payload digest for exact replay; the public run
 * log and the body catalog carry only this scoped immutable object reference. */
export async function prepareRunOutputChunkPayload(input: AppendHeartbeatRunEventInput, store?: HistoryPayloadStore): Promise<Record<string, unknown> | null> {
  if (input.eventType !== "output.body.chunk") return input.payload ?? null;
  const event = object(input.payload?.prpEvent), chunk = object(event.payload);
  const canonical = object(input.nativeSource?.canonicalPayload.payload);
  if (typeof chunk.text !== "string" || !chunk.text.length || Buffer.byteLength(chunk.text) > MAX_CHUNK_BYTES ||
    chunk.schema !== "paperclip.output.body.chunk.v1" || digest(chunk.text) !== chunk.sha256 ||
    canonical.text !== chunk.text || canonical.sha256 !== chunk.sha256) throw new Error("native_output_body_binding_invalid");
  const { text, ...metadata } = chunk;
  const textRef = await (store ?? createHistoryPayloadStore()).put({ companyId: input.companyId, runId: input.runId }, Buffer.from(text), "text/plain; charset=utf-8");
  return { ...input.payload, prpEvent: { ...event, payload: { ...metadata, textRef } } };
}

export async function readRunOutputChunk(scope: { companyId: string; runId: string }, value: unknown, store?: HistoryPayloadStore): Promise<Record<string, unknown>> {
  const chunk = object(value);
  if (chunk.textRef === undefined) return chunk; // Retained inline events.
  if (chunk.text !== undefined || object(chunk.textRef).sha256 !== chunk.sha256 || object(chunk.textRef).mediaType !== "text/plain; charset=utf-8") throw conflict("Stored output reference failed verification");
  const text = (await (store ?? createHistoryPayloadStore()).read(scope, chunk.textRef, MAX_CHUNK_BYTES)).toString("utf8");
  return { ...chunk, text };
}

/** Read only one immutable body. Pages and the one-frame allocation are bounded.
 * Never serve partial output as complete, including a crash before the last chunk.
 * Run-specific redaction must be applied to the complete frame by the caller so
 * a registered secret split across transport chunks cannot escape that policy. */
export async function assembleRunOutputBody(bodyId: string, chunks: AsyncIterable<unknown>): Promise<string> {
  if (!hex.test(bodyId)) throw notFound("Output not found");
  let bytes = 0, size = 0;
  const parts: string[] = [];
  for await (const value of chunks) {
    const chunk = object(value), body = object(chunk.body);
    const text = chunk.text;
    const offset = typeof chunk.offset === "string" && /^(0|[1-9][0-9]{0,6})$/.test(chunk.offset) ? Number(chunk.offset) : -1;
    const declared = typeof body.byteLength === "string" && /^[1-9][0-9]{0,6}$/.test(body.byteLength) ? Number(body.byteLength) : 0;
    if (chunk.schema !== "paperclip.output.body.chunk.v1" || body.schema !== "paperclip.output.body.v1" ||
      body.bodyId !== bodyId || body.sha256 !== bodyId || body.mediaType !== "text/plain; charset=utf-8" ||
      typeof text !== "string" || offset !== bytes || declared < 1 || declared > MAX_RUN_OUTPUT_BODY_BYTES ||
      (bytes > 0 && declared !== size) || Buffer.byteLength(text) > MAX_CHUNK_BYTES || text.length === 0 ||
      digest(text) !== chunk.sha256) throw conflict("Stored output failed verification");
    size = declared; bytes += Buffer.byteLength(text);
    if (bytes > size) throw conflict("Stored output exceeds its declared length");
    parts.push(text);
    if (bytes === size) {
      const result = parts.join("");
      if (digest(result) !== bodyId) throw conflict("Stored output failed verification");
      return result;
    }
  }
  if (!parts.length) throw notFound("Output not found");
  throw conflict("Output is not complete yet");
}

export async function readRunOutputBody(db: Db, companyId: string, runId: string, bodyId: string): Promise<string> {
  async function* pages() {
    let after = -1;
    for (;;) {
      const rows = await db.select({ payload: heartbeatRunEvents.payload, chunkOffset: nativeOutputBodyChunks.chunkOffset })
        .from(nativeOutputBodyChunks).innerJoin(heartbeatRunEvents, and(
          eq(heartbeatRunEvents.id, nativeOutputBodyChunks.eventId),
          eq(heartbeatRunEvents.companyId, nativeOutputBodyChunks.companyId),
          eq(heartbeatRunEvents.runId, nativeOutputBodyChunks.runId),
        )).where(and(
          eq(nativeOutputBodyChunks.companyId, companyId), eq(nativeOutputBodyChunks.runId, runId),
          eq(nativeOutputBodyChunks.bodyId, bodyId), gt(nativeOutputBodyChunks.chunkOffset, after),
        )).orderBy(asc(nativeOutputBodyChunks.chunkOffset)).limit(128);
      if (!rows.length) return;
      for (const row of rows) {
        after = row.chunkOffset;
        yield await readRunOutputChunk({ companyId, runId }, object(object(row.payload).prpEvent).payload);
      }
    }
  }
  return assembleRunOutputBody(bodyId, pages());
}
