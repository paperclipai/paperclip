import { describe, it, expect, vi } from "vitest";
import { LidarPipeline } from "../pipeline.js";
import { buildSyntheticLasBuffer } from "../ingestion.js";
import type { IngestionEvent, NormalizedPoint, SensorConfig } from "../types.js";

const SENSOR: SensorConfig = {
  sensorId: "sensor-integration-01",
  location: "Plot-B-SW",
  sourceCrsEpsg: 32610,
  utmZone: 10,
  utmHemisphere: "N",
};

function makeEvent(
  points: Array<{ x: number; y: number; z: number }>,
  overrides: Partial<IngestionEvent> = {},
): IngestionEvent {
  return {
    eventId: "test-event-" + Math.random().toString(36).slice(2),
    sensorConfig: SENSOR,
    format: "las",
    payload: buildSyntheticLasBuffer(points),
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe("LidarPipeline — integration (synthetic data stream)", () => {
  it("processes a single LAS event end-to-end and emits normalized WGS84 points", async () => {
    const pipeline = new LidarPipeline();
    const batches: Array<[string, NormalizedPoint[]]> = [];
    pipeline.on("batch", (id, pts) => batches.push([id, pts]));

    const event = makeEvent([
      { x: 526914, y: 5040778, z: 50 },
      { x: 527000, y: 5040900, z: 55 },
      { x: 527100, y: 5041000, z: 60 },
    ]);

    await pipeline.process(event);

    expect(batches).toHaveLength(1);
    const [sensorId, pts] = batches[0];
    expect(sensorId).toBe(SENSOR.sensorId);
    expect(pts.length).toBeGreaterThan(0);

    for (const p of pts) {
      expect(p.latitude).toBeGreaterThan(44);
      expect(p.latitude).toBeLessThan(47);
      expect(p.longitude).toBeGreaterThan(-124);
      expect(p.longitude).toBeLessThan(-121);
      expect(isFinite(p.elevation)).toBe(true);
    }
  });

  it("calls onBatch callback with processed points", async () => {
    const onBatch = vi.fn();
    const pipeline = new LidarPipeline({ onBatch });

    await pipeline.process(makeEvent([{ x: 526914, y: 5040778, z: 50 }]));

    expect(onBatch).toHaveBeenCalledOnce();
    expect(onBatch.mock.calls[0][0]).toBe(SENSOR.sensorId);
    expect(Array.isArray(onBatch.mock.calls[0][1])).toBe(true);
  });

  it("emits an error event for malformed payload and continues processing", async () => {
    const pipeline = new LidarPipeline();
    const errors: Error[] = [];
    const batches: NormalizedPoint[][] = [];
    pipeline.on("error", (_ev, err) => errors.push(err));
    pipeline.on("batch", (_id, pts) => batches.push(pts));

    const badEvent: IngestionEvent = {
      eventId: "bad",
      sensorConfig: SENSOR,
      format: "las",
      payload: Buffer.from("this is not a LAS file"),
      receivedAt: Date.now(),
    };
    const goodEvent = makeEvent([{ x: 526914, y: 5040778, z: 50 }]);

    await pipeline.process(badEvent);
    await pipeline.process(goodEvent);

    expect(errors).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it("strips noise-class (7) points before emitting", async () => {
    const pipeline = new LidarPipeline();
    const batches: NormalizedPoint[][] = [];
    pipeline.on("batch", (_id, pts) => batches.push(pts));

    const buf = buildSyntheticLasBuffer([
      { x: 526914, y: 5040778, z: 50, classification: 1 },
      { x: 526920, y: 5040780, z: 50, classification: 7 },
      { x: 526930, y: 5040790, z: 50, classification: 2 },
    ]);
    const event: IngestionEvent = {
      eventId: "e1",
      sensorConfig: SENSOR,
      format: "las",
      payload: buf,
      receivedAt: Date.now(),
    };

    await pipeline.process(event);

    expect(batches).toHaveLength(1);
    expect(batches[0].every((p) => p.classification !== 7)).toBe(true);
    expect(batches[0]).toHaveLength(2);
  });

  it("updates health metrics after processing events", async () => {
    const pipeline = new LidarPipeline();

    const h0 = pipeline.health();
    expect(h0.status).toBe("no_data");
    expect(h0.activeSensors).toBe(0);

    await pipeline.process(
      makeEvent([
        { x: 526914, y: 5040778, z: 50 },
        { x: 527000, y: 5040900, z: 55 },
      ]),
    );

    const h1 = pipeline.health();
    expect(h1.status).toBe("ok");
    expect(h1.activeSensors).toBe(1);
    expect(h1.lastSeenAt).not.toBeNull();
    expect(h1.ingestionRate).toBeGreaterThan(0);
  });

  it("streams multiple events from multiple sensors correctly", async () => {
    const pipeline = new LidarPipeline();
    const batches: Array<[string, number]> = [];
    pipeline.on("batch", (id, pts) => batches.push([id, pts.length]));

    const sensor2Config: SensorConfig = { ...SENSOR, sensorId: "sensor-integration-02" };

    await pipeline.process(makeEvent([{ x: 526914, y: 5040778, z: 50 }]));
    await pipeline.process({
      ...makeEvent([{ x: 526914, y: 5040778, z: 50 }, { x: 527000, y: 5040900, z: 55 }]),
      sensorConfig: sensor2Config,
    });
    await pipeline.process(makeEvent([{ x: 526950, y: 5040800, z: 52 }]));

    expect(batches).toHaveLength(3);
    expect(batches.filter(([id]) => id === "sensor-integration-01")).toHaveLength(2);
    expect(batches.filter(([id]) => id === "sensor-integration-02")).toHaveLength(1);

    const health = pipeline.health();
    expect(health.activeSensors).toBe(2);
  });
});
