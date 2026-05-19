import { describe, it, expect } from "vitest";
import { utmToWgs84, normalizePoints } from "../normalization.js";
import type { RawLidarPoint, SensorConfig } from "../types.js";

// Known reference: UTM Zone 10N (EPSG:32610)
// Portland, OR area — USGS benchmark verified values
const UTM_ZONE_10N_CONFIG: SensorConfig = {
  sensorId: "sensor-001",
  location: "Plot-A",
  sourceCrsEpsg: 32610,
  utmZone: 10,
  utmHemisphere: "N",
};

describe("utmToWgs84", () => {
  it("converts a known UTM zone 10N point to approximate WGS84 lat/lon", () => {
    // Portland, OR area — UTM 10N E 526914, N 5040778
    // Expected WGS84 verified via round-trip: lat ~45.52, lon ~-122.66
    const result = utmToWgs84(526914, 5040778, 50, 10, "N");

    expect(result.latitude).toBeCloseTo(45.52, 1);
    expect(result.longitude).toBeCloseTo(-122.66, 1);
    expect(result.elevation).toBe(50);
  });

  it("converts a southern hemisphere UTM point correctly", () => {
    // Sydney, AU: approx lat -33.87, lon 151.21
    // UTM 56S with false northing applied: N ≈ 6252038 (= 10_000_000 - 3_747_962)
    // The function internally subtracts the 10 M false northing for 'S' hemisphere.
    const result = utmToWgs84(334218, 6252038, 5, 56, "S");

    expect(result.latitude).toBeCloseTo(-33.86, 1);
    expect(result.latitude).toBeLessThan(0);
    expect(result.longitude).toBeGreaterThan(150);
    expect(result.longitude).toBeLessThan(153);
  });

  it("preserves elevation unchanged", () => {
    const result = utmToWgs84(526914, 5040778, 1234.5, 10, "N");
    expect(result.elevation).toBe(1234.5);
  });
});

describe("normalizePoints", () => {
  it("transforms all points in a batch", () => {
    const raw: RawLidarPoint[] = [
      { x: 526914, y: 5040778, z: 50, intensity: 1000, classification: 1, timestamp: 1000, returnNumber: 1, numberOfReturns: 1 },
      { x: 527000, y: 5040900, z: 55, intensity: 900, classification: 2, timestamp: 1001, returnNumber: 1, numberOfReturns: 1 },
    ];

    const result = normalizePoints(raw, UTM_ZONE_10N_CONFIG);
    expect(result).toHaveLength(2);

    for (const p of result) {
      expect(p.latitude).toBeGreaterThan(45);
      expect(p.latitude).toBeLessThan(46);
      expect(p.longitude).toBeGreaterThan(-123);
      expect(p.longitude).toBeLessThan(-122);
    }
  });

  it("preserves intensity and classification on each point", () => {
    const raw: RawLidarPoint[] = [
      { x: 526914, y: 5040778, z: 50, intensity: 4095, classification: 5, timestamp: 999, returnNumber: 1, numberOfReturns: 1 },
    ];
    const [p] = normalizePoints(raw, UTM_ZONE_10N_CONFIG);
    expect(p.intensity).toBe(4095);
    expect(p.classification).toBe(5);
    expect(p.timestamp).toBe(999);
  });

  it("preserves return metadata (returnNumber and numberOfReturns) on each point", () => {
    const raw: RawLidarPoint[] = [
      { x: 526914, y: 5040778, z: 50, intensity: 1000, classification: 1, timestamp: 1000, returnNumber: 2, numberOfReturns: 3 },
      { x: 527000, y: 5040900, z: 55, intensity: 900, classification: 2, timestamp: 1001, returnNumber: 1, numberOfReturns: 1 },
    ];
    const result = normalizePoints(raw, UTM_ZONE_10N_CONFIG);
    expect(result[0].returnNumber).toBe(2);
    expect(result[0].numberOfReturns).toBe(3);
    expect(result[1].returnNumber).toBe(1);
    expect(result[1].numberOfReturns).toBe(1);
  });

  it("returns an empty array for an empty input batch", () => {
    expect(normalizePoints([], UTM_ZONE_10N_CONFIG)).toEqual([]);
  });
});
