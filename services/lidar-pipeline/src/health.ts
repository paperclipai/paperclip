import type { HealthStatus } from "./types.js";

/** Rolling window for computing ingestion rate over 60 seconds. */
export class IngestionTracker {
  private windowMs = 60_000;
  private events: Array<{ ts: number; count: number }> = [];
  private lastSeenBySensor = new Map<string, number>();

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

    const status: HealthStatus["status"] =
      activeSensors === 0 ? "no_data" : "ok";

    return { status, activeSensors, lastSeenAt, ingestionRate };
  }
}
