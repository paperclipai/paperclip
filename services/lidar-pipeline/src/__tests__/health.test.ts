import { describe, it, expect } from "vitest";
import { IngestionTracker } from "../health.js";

describe("IngestionTracker", () => {
  it("starts with no_data status when no records have been posted", () => {
    const tracker = new IngestionTracker();
    const status = tracker.getStatus();
    expect(status.status).toBe("no_data");
    expect(status.activeSensors).toBe(0);
    expect(status.lastSeenAt).toBeNull();
    expect(status.ingestionRate).toBe(0);
  });

  it("transitions to ok after the first record", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 100, now);
    const status = tracker.getStatus(now);
    expect(status.status).toBe("ok");
    expect(status.activeSensors).toBe(1);
    expect(status.lastSeenAt).toBe(now);
  });

  it("computes ingestion rate as total points / 60 s window", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 6_000, now);
    const { ingestionRate } = tracker.getStatus(now);
    expect(ingestionRate).toBe(100); // 6000 / 60
  });

  it("accumulates multiple records from multiple sensors within the window", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 1_200, now - 30_000);
    tracker.record("sensor-a", 1_800, now - 10_000);
    tracker.record("sensor-b", 600, now);
    const status = tracker.getStatus(now);
    expect(status.activeSensors).toBe(2);
    expect(status.ingestionRate).toBe(60); // 3600 / 60
  });

  it("evicts records older than 60 seconds", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 9_000, now - 61_000);
    tracker.record("sensor-b", 120, now);
    const status = tracker.getStatus(now);
    expect(status.activeSensors).toBe(1);
    expect(status.ingestionRate).toBe(2); // 120 / 60
  });

  it("reverts to no_data when all sensors fall outside the rolling window", () => {
    const tracker = new IngestionTracker();
    const baseTime = 1_000_000;
    tracker.record("sensor-a", 100, baseTime);
    const status = tracker.getStatus(baseTime + 61_000);
    expect(status.status).toBe("no_data");
    expect(status.activeSensors).toBe(0);
    expect(status.lastSeenAt).toBeNull();
  });

  it("reports the most-recent lastSeenAt across all active sensors", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 50, now - 5_000);
    tracker.record("sensor-b", 50, now - 2_000);
    tracker.record("sensor-c", 50, now - 1_000);
    const status = tracker.getStatus(now);
    expect(status.activeSensors).toBe(3);
    expect(status.lastSeenAt).toBe(now - 1_000);
  });

  it("handles a zero-point-count record without error", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 0, now);
    const status = tracker.getStatus(now);
    expect(status.status).toBe("ok");
    expect(status.ingestionRate).toBe(0);
  });

  it("uses Date.now() as the default timestamp for record and getStatus", () => {
    const tracker = new IngestionTracker();
    const before = Date.now();
    tracker.record("sensor-a", 100);
    const status = tracker.getStatus();
    const after = Date.now();
    expect(status.status).toBe("ok");
    expect(status.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(status.lastSeenAt!).toBeLessThanOrEqual(after);
  });

  it("correctly evicts a sensor from activeSensors after its last record expires", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 100, now - 61_000);
    tracker.record("sensor-b", 100, now);
    // At now+1 sensor-a is outside window, sensor-b is inside
    const status = tracker.getStatus(now + 1);
    expect(status.activeSensors).toBe(1);
    expect(status.lastSeenAt).toBe(now);
  });

  it("records multiple batches from the same sensor and counts it once in activeSensors", () => {
    const tracker = new IngestionTracker();
    const now = 1_000_000;
    tracker.record("sensor-a", 100, now - 10_000);
    tracker.record("sensor-a", 200, now - 5_000);
    tracker.record("sensor-a", 300, now);
    const status = tracker.getStatus(now);
    expect(status.activeSensors).toBe(1);
    expect(status.ingestionRate).toBe(10); // 600 / 60
  });
});
