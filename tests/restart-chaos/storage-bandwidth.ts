import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export class ByteRate {
  private next = 0;
  private released = false;

  constructor(readonly bytesPerSecond: number, private readonly now: () => number = Date.now) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) throw new Error("A bandwidth cap needs a positive bytes-per-second rate");
  }

  release(): void { this.released = true; }

  reserve(bytes: number): number {
    if (this.released) return 0;
    const now = this.now();
    this.next = Math.max(this.next, now) + (bytes * 1_000) / this.bytesPerSecond;
    return Math.max(0, Math.round(this.next - now));
  }
}

export interface LinkRates { up: ByteRate; down: ByteRate }

export function releaseLinks(links: Iterable<LinkRates>): void {
  for (const link of links) { link.up.release(); link.down.release(); }
}

export function linkRates(bytesPerSecond: number, now?: () => number): LinkRates {
  return { up: new ByteRate(bytesPerSecond, now), down: new ByteRate(bytesPerSecond, now) };
}

export function paced(rate: ByteRate, chunkBytes = 64 * 1024): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += chunkBytes) {
          const piece = chunk.subarray(offset, Math.min(chunk.length, offset + chunkBytes));
          const wait = rate.reserve(piece.length);
          if (wait > 0) await delay(wait);
          this.push(piece);
        }
      })().then(() => callback(), callback);
    },
  });
}

export function bandwidthDraw(random: () => number): number {
  return Math.round(2 ** (1 + random() * 3) * 1024 * 1024);
}
