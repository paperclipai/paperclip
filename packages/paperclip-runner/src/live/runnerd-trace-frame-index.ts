import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

const READ_BUDGET_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;

type Frame = { frameId: number | null; record: number };

/** Incremental, best-effort index of the append-only native debug trace. */
export class RunnerdTraceFrameIndex {
  #identity = "";
  #offset = 0;
  #mtimeMs = 0;
  #record = 0;
  #settledAt = 0;
  #partial: Buffer[] = [];
  #partialBytes = 0;
  #discardUntilNewline = false;
  #frames = new Map<string, Frame>();

  locate(tracePath: string, sourceEventId: string) {
    const stat = statSync(tracePath);
    const identity = `${stat.dev}:${stat.ino}`;
    if (
      identity !== this.#identity || stat.size < this.#offset ||
      (stat.size === this.#offset && stat.mtimeMs !== this.#mtimeMs)
    ) {
      this.clear();
      this.#identity = identity;
    }
    this.#mtimeMs = stat.mtimeMs;
    if (stat.size > this.#offset) {
      const fd = openSync(tracePath, "r");
      try {
        const opened = fstatSync(fd);
        // Do not mix a replacement file with the prefix we already indexed.
        if (`${opened.dev}:${opened.ino}` !== identity) {
          return { frameId: null, nativeChannelSettled: false };
        }
        const buffer = Buffer.allocUnsafe(Math.min(READ_BUDGET_BYTES, stat.size - this.#offset));
        const bytes = readSync(fd, buffer, 0, buffer.length, this.#offset);
        this.#offset += bytes;
        let start = 0;
        for (let end = buffer.indexOf(10); end !== -1 && end < bytes; end = buffer.indexOf(10, start)) {
          this.#consume(buffer.subarray(start, end), true);
          start = end + 1;
        }
        if (start < bytes) this.#consume(buffer.subarray(start, bytes), false);
      } finally {
        closeSync(fd);
      }
    }
    // Until the observed suffix is indexed, a later interpretation or terminal
    // status may supersede the prefix. Let the existing pending queue retry.
    if (this.#offset < stat.size || this.#partialBytes > 0 || this.#discardUntilNewline) {
      return { frameId: null, nativeChannelSettled: false };
    }
    const frame = this.#frames.get(sourceEventId);
    return {
      frameId: frame?.frameId ?? null,
      nativeChannelSettled: this.#settledAt > (frame?.record ?? 0),
    };
  }

  clear() {
    this.#identity = "";
    this.#offset = 0;
    this.#mtimeMs = 0;
    this.#record = 0;
    this.#settledAt = 0;
    this.#partial = [];
    this.#partialBytes = 0;
    this.#discardUntilNewline = false;
    this.#frames.clear();
  }

  #consume(part: Buffer, terminated: boolean) {
    if (this.#discardUntilNewline || this.#partialBytes + part.length > MAX_RECORD_BYTES) {
      // Raw provider frames can be tens of MiB. Correlation needs only small
      // interpretation/status records; leave oversized records in the raw file.
      this.#partial = [];
      this.#partialBytes = 0;
      this.#discardUntilNewline = !terminated;
      return;
    }
    if (!terminated) {
      this.#partial.push(Buffer.from(part));
      this.#partialBytes += part.length;
      return;
    }
    const line = this.#partialBytes > 0
      ? Buffer.concat([...this.#partial, part]).toString("utf8")
      : part.toString("utf8");
    this.#partial = [];
    this.#partialBytes = 0;
    this.#indexLine(line);
  }

  #indexLine(line: string) {
    if (!line.trim()) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      // A damaged debug record must not block later valid correlations.
      return;
    }
    if (!entry || typeof entry !== "object") return;
    this.#record += 1;
    if (entry.kind === "trace_status" && entry.debugChannel === "rust_native") {
      this.#settledAt = this.#record;
    }
    if (entry.kind !== "interpretation" || !Array.isArray(entry.emittedEventIds)) return;
    const frameId = typeof entry.frameId === "number" ? entry.frameId : null;
    for (const eventId of entry.emittedEventIds) {
      if (typeof eventId === "string") this.#frames.set(eventId, { frameId, record: this.#record });
    }
  }
}
