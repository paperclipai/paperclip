import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface LegacyJsonCursor {
  offset: number;
  phase: "start" | "field" | "entry" | "entry_separator" | "field_separator" | "done";
  fields: string[];
  collection: { field: string; kind: "array" | "object"; index: string } | null;
  prefixDigest: string;
}
export interface LegacyJsonEntry { field: string; key: string | null; value: unknown }
export interface LegacyJsonPage { source: string; cursor: LegacyJsonCursor; entries: LegacyJsonEntry[]; done: boolean }
const CHUNK = 64 * 1024;
const MAX_VALUE = 16 * 1024 * 1024;
const MAX_PAGE = 8 * 1024 * 1024;
const collections: Record<string, "array" | "object"> = { commands: "array", committedEvents: "array", commandDeliveryCounts: "object" };
const invalid = () => new Error("invalid legacy migration JSON or cursor");

class Scanner {
  offset: number;
  private buffer = Buffer.allocUnsafe(CHUNK);
  private begin = -1;
  private length = 0;
  private fd: number;
  private size: number;
  constructor(fd: number, size: number, offset: number) { this.fd = fd; this.size = size; this.offset = offset; }
  peek(): number {
    if (this.offset >= this.size) return -1;
    if (this.offset < this.begin || this.offset >= this.begin + this.length) {
      this.begin = this.offset;
      this.length = readSync(this.fd, this.buffer, 0, Math.min(CHUNK, this.size - this.offset), this.offset);
      if (!this.length) throw new Error("legacy migration source changed");
    }
    return this.buffer[this.offset - this.begin]!;
  }
  space(): void { while ([32, 9, 10, 13].includes(this.peek())) this.offset++; }
  expect(byte: number): void { this.space(); if (this.peek() !== byte) throw invalid(); this.offset++; }
  /** Locate one JSON value with bounded memory, then let the JSON parser
   * validate its complete grammar. Delimiters inside strings remain data. */
  value(maximum = MAX_VALUE): { value: unknown; bytes: number } {
    this.space();
    const start = this.offset;
    const first = this.peek();
    if (first < 0 || [44, 93, 125].includes(first)) throw invalid();
    let depth = 0, quoted = false, escaped = false;
    const container = first === 91 || first === 123;
    for (;;) {
      const byte = this.peek();
      if (byte < 0) {
        if (quoted || depth > 0 || container) throw invalid();
        break;
      }
      if (!quoted && depth === 0 && this.offset > start && [32, 9, 10, 13, 44, 93, 125].includes(byte)) break;
      this.offset++;
      if (this.offset - start > maximum) throw new Error("legacy migration record exceeds bounded admission capacity");
      if (quoted) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) { quoted = false; if (depth === 0) break; }
      } else if (byte === 34) quoted = true;
      else if (byte === 91 || byte === 123) { if (++depth > 128) throw invalid(); }
      else if (byte === 93 || byte === 125) { if (--depth === 0) break; if (depth < 0) throw invalid(); }
    }
    const length = this.offset - start;
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(this.fd, bytes, offset, length - offset, start + offset);
      if (!count) throw new Error("legacy migration source changed");
      offset += count;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes: length };
  }
}

/** Worker-only lossless input. No total file limit; each page has a durable,
 * seekable cursor. Callers must hold the migration's exclusive ownership fence
 * and persist the page's records and cursor in the same staging transaction. */
export function scanLegacyJsonPage(path: string, expectedSource: string | null, previous: LegacyJsonCursor | null): LegacyJsonPage {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.getuid!())))) throw new Error("unsafe legacy migration source");
    const identity = (value: typeof stat) => JSON.stringify([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String));
    const source = identity(stat);
    if (expectedSource !== null && expectedSource !== source) throw new Error("legacy migration source changed");
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size)) throw new Error("legacy migration source exceeds filesystem seek range");
    const cursor: LegacyJsonCursor = structuredClone(previous ?? { offset: 0, phase: "start", fields: [], collection: null, prefixDigest: "0".repeat(64) });
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > size || !Array.isArray(cursor.fields) || cursor.fields.length > 128 || !/^[0-9a-f]{64}$/.test(cursor.prefixDigest)) throw invalid();
    const scanner = new Scanner(fd, size, cursor.offset);
    const begin = cursor.offset;
    const entries: LegacyJsonEntry[] = [];
    let bytes = 0;
    while (entries.length < 128 && bytes < MAX_PAGE && cursor.phase !== "done") {
      if (cursor.phase === "start") { scanner.expect(123); cursor.phase = "field"; }
      else if (cursor.phase === "field") {
        scanner.space();
        if (scanner.peek() === 125) { scanner.offset++; cursor.phase = "done"; continue; }
        const key = scanner.value(4096).value;
        if (typeof key !== "string" || cursor.fields.includes(key) || cursor.fields.length >= 128) throw invalid();
        cursor.fields.push(key); scanner.expect(58);
        const kind = Object.hasOwn(collections, key) ? collections[key]! : null;
        if (kind) { scanner.expect(kind === "array" ? 91 : 123); cursor.collection = { field: key, kind, index: "0" }; cursor.phase = "entry"; }
        else { const value = scanner.value(); entries.push({ field: key, key: null, value: value.value }); bytes += value.bytes; cursor.phase = "field_separator"; }
      } else if (cursor.phase === "entry") {
        const collection = cursor.collection;
        if (!collection || collections[collection.field] !== collection.kind || !/^(0|[1-9][0-9]*)$/.test(collection.index) || collection.index.length > 32) throw invalid();
        scanner.space();
        if (scanner.peek() === (collection.kind === "array" ? 93 : 125)) { scanner.offset++; cursor.collection = null; cursor.phase = "field_separator"; continue; }
        let key = collection.index;
        if (collection.kind === "object") {
          const parsed = scanner.value(4096).value;
          if (typeof parsed !== "string") throw invalid();
          key = parsed; scanner.expect(58);
        }
        const value = scanner.value();
        entries.push({ field: collection.field, key, value: value.value }); bytes += value.bytes;
        collection.index = String(BigInt(collection.index) + 1n); cursor.phase = "entry_separator";
      } else if (cursor.phase === "entry_separator") {
        const collection = cursor.collection;
        if (!collection) throw invalid();
        scanner.space();
        if (scanner.peek() === (collection.kind === "array" ? 93 : 125)) { scanner.offset++; cursor.collection = null; cursor.phase = "field_separator"; }
        else { scanner.expect(44); scanner.space(); if ([93, 125].includes(scanner.peek())) throw invalid(); cursor.phase = "entry"; }
      } else if (cursor.phase === "field_separator") {
        scanner.space();
        if (scanner.peek() === 125) { scanner.offset++; cursor.phase = "done"; }
        else { scanner.expect(44); scanner.space(); if (scanner.peek() === 125) throw invalid(); cursor.phase = "field"; }
      } else throw invalid();
    }
    if (cursor.phase === "done") { scanner.space(); if (scanner.offset !== size) throw invalid(); }
    const digest = createHash("sha256").update(Buffer.from(cursor.prefixDigest, "hex"));
    const buffer = Buffer.allocUnsafe(CHUNK);
    for (let offset = begin; offset < scanner.offset;) {
      const count = readSync(fd, buffer, 0, Math.min(CHUNK, scanner.offset - offset), offset);
      if (!count) throw new Error("legacy migration source changed");
      digest.update(buffer.subarray(0, count)); offset += count;
    }
    if (source !== identity(fstatSync(fd, { bigint: true }))) throw new Error("legacy migration source changed");
    cursor.offset = scanner.offset; cursor.prefixDigest = digest.digest("hex");
    return { source, cursor, entries, done: cursor.phase === "done" };
  } finally { closeSync(fd); }
}
