import { createHash } from "node:crypto";
import type { IndexedLocalSnapshot } from "./indexed-local-state-reader.js";

const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const { authorityGeneration } = await import(new URL(`./durable-authority-store.${extension}`, import.meta.url).href) as typeof import("./durable-authority-store.js");

const CHUNK_BYTES = 192 * 1024;
const MAX_SNAPSHOT_BYTES = 40 * 1024 * 1024;
const MAX_FRAME_BYTES = CHUNK_BYTES * 4 / 3 + 128;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("native_indexed_inspection_invalid_or_incomplete");
const digest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]+$/.test(value);

/** Decoder shared by local worker reads and owned remote inspection channels.
 * Limits apply to one bounded current snapshot, never accumulated history. */
export class IndexedInspectionDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private header?: { byteLength: number; sha256: string };
  private chunks: Buffer[] = [];
  private hash = createHash("sha256");
  private length = 0;
  private complete = false;
  private finished = false;

  push(chunk: Uint8Array): void {
    if (this.finished) throw invalid();
    try {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      while (start < bytes.length) {
        const end = bytes.indexOf(10, start);
        const part = bytes.subarray(start, end < 0 ? bytes.length : end);
        if (this.pending.length + part.length > MAX_FRAME_BYTES) throw invalid();
        this.pending = Buffer.concat([this.pending, part]);
        if (end < 0) break;
        this.line(this.pending); this.pending = Buffer.alloc(0); start = end + 1;
      }
    } catch { throw invalid(); }
  }

  private line(bytes: Buffer): void {
    if (this.complete) throw invalid();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(value)) throw invalid();
    if (!this.header) {
      if (value.schema !== "paperclip.indexed-inspection.v1" || !Number.isSafeInteger(value.byteLength) ||
        Number(value.byteLength) < 1 || Number(value.byteLength) > MAX_SNAPSHOT_BYTES || !digest(value.sha256)) throw invalid();
      this.header = { byteLength: Number(value.byteLength), sha256: value.sha256 };
    } else if (value.complete === true) {
      if (Object.keys(value).length !== 1 || this.length !== this.header.byteLength) throw invalid();
      this.complete = true;
    } else {
      if (value.index !== this.chunks.length || typeof value.bytes !== "string" || value.bytes.length > CHUNK_BYTES * 4 / 3) throw invalid();
      const chunk = Buffer.from(value.bytes, "base64");
      if (chunk.toString("base64") !== value.bytes || chunk.length !== Math.min(CHUNK_BYTES, this.header.byteLength - this.length) || chunk.length === 0) throw invalid();
      this.hash.update(chunk); this.chunks.push(chunk); this.length += chunk.length;
    }
  }

  /** Call only after a clean native process exit and the complete stdout stream. */
  finish(): IndexedLocalSnapshot {
    if (this.finished) throw invalid();
    this.finished = true;
    try {
      if (this.pending.length || !this.complete || !this.header || this.hash.digest("hex") !== this.header.sha256) throw invalid();
      const value: unknown = JSON.parse(Buffer.concat(this.chunks, this.length).toString("utf8"));
      if (!object(value) || !object(value.state) || typeof value.generation !== "string" || value.generation !== value.generation.trim() ||
        value.generation === "0" || !digest(value.stateDigest) ||
        (value.preparation !== null && !object(value.preparation))) throw invalid();
      authorityGeneration(value.generation);
      return value as unknown as IndexedLocalSnapshot;
    } catch { throw invalid(); }
    finally { this.chunks = []; }
  }
}
