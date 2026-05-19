import type { HealthStatus } from "./types.js";

export interface IngestionTrackerOptions {
  /** Window size for rate computation and sensor eviction. Default 60 000 ms. */
  windowMs?: number;
  /** Age threshold beyond which an active sensor is considered stale → "degraded". Default 30 000 ms. */
  staleThresholdMs?: number;
}

/** Rolling window for computing ingestion rate over 60 seconds. */
export class IngestionTracker {
  private windowMs: number;
  private staleThresholdMs: number;
  private events: Array<{ ts: number; count: number }> = [];
  private lastSeenBySensor = new Map<string, number>();

  constructor(opts: IngestionTrackerOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 30_000;
  }

  record(sensorId: string, pointCount: number, now = Date.now()): void {
    this.events.push({ ts: now, count: pointCount });
    this.lastSeenBySensor.set(sensorId, now);
    this.evict(now);
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    this.events = this.events.filter((e) => e.ts >= cutoff);
    for (const [id, ts] of this.lastSeenBySensor) {
      if (ts < cutoff) this.lastSeenBySensor.delete(id);
    }
  }

  getStatus(now = Date.now()): HealthStatus {
    this.evict(now);

    const activeSensors = this.lastSeenBySensor.size;
    const lastSeenValues = [...this.lastSeenBySensor.values()];
    const lastSeenAt =
      lastSeenValues.length > 0 ? Math.max(...lastSeenValues) : null;

    const totalPoints = this.events.reduce((s, e) => s + e.count, 0);
    const windowSec = this.windowMs / 1000;
    const ingestionRate = totalPoints / windowSec;

    let status: HealthStatus["status"];
    if (activeSensors === 0) {
      status = "no_data";
    } else if (lastSeenAt !== null && now - lastSeenAt > this.staleThresholdMs) {
      status = "degraded";
    } else {
      status = "ok";
    }

    return { status, activeSensors, lastSeenAt, ingestionRate };
  }
}
