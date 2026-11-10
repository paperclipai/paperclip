import { objectPath, s3Operation } from "./storage-s3-ops.js";
import type { StorageFaultRule } from "./storage-proxy.js";

export const LAG_MS_RANGE: readonly [number, number] = [5_000, 30_000];
const FORGET_AFTER_MS = 10 * 60_000;

export function lagFaultRules(random: () => number): StorageFaultRule[] {
  const [min, max] = LAG_MS_RANGE;
  return [{ fault: { kind: "read_after_write_lag", lagMs: min + Math.round(random() * (max - min)) },
    methods: ["GET", "HEAD"], operations: ["GetObject", "HeadObject"] }];
}

export class ReadAfterWriteTracker {
  private readonly written = new Map<string, number>();
  lagged = 0;

  constructor(private readonly now: () => number = Date.now) {}

  note(method: string, url: string, status: number): void {
    if (status < 200 || status >= 300) return;
    const operation = s3Operation(method, url);
    if (operation !== "PutObject" && operation !== "CompleteMultipartUpload") return;
    const at = this.now();
    this.written.set(objectPath(url), at);
    for (const [key, writtenAt] of this.written) if (at - writtenAt > FORGET_AFTER_MS) this.written.delete(key);
  }

  lagging(url: string, lagMs: number): boolean {
    const writtenAt = this.written.get(objectPath(url));
    const lagging = writtenAt !== undefined && this.now() - writtenAt < lagMs;
    if (lagging) this.lagged += 1;
    return lagging;
  }
}
