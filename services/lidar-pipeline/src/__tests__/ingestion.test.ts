import { describe, it, expect } from "vitest";
import { parseLas, buildSyntheticLasBuffer, LasParseError } from "../ingestion.js";
import { filterOutliers } from "../filter.js";

describe("parseLas", () => {
  it("parses a synthetic LAS 1.2 format-0 buffer correctly", () => {
    const pts = [
      { x: 526914.12, y: 5040778.56, z: 50.0 },
      { x: 526920.00, y: 5040790.00, z: 52.5 },
      { x: 526930.50, y: 5040800.25, z: 51.0 },
    ];
    const buf = buildSyntheticLasBuffer(pts);
    const result = parseLas(buf, Date.now());

    expect(result).toHaveLength(3);

    // Scale factor is 0.01 by default so precision is ±0.01 m
    expect(result[0].x).toBeCloseTo(pts[0].x, 1);
    expect(result[0].y).toBeCloseTo(pts[0].y, 1);
    expect(result[0].z).toBeCloseTo(pts[0].z, 1);

    expect(result[1].x).toBeCloseTo(pts[1].x, 1);
    expect(result[2].z).toBeCloseTo(pts[2].z, 1);
  });

  it("uses the supplied timestamp when GPS time is unavailable (format 0)", () => {
    const ts = 1_700_000_000_000;
    const buf = buildSyntheticLasBuffer([{ x: 0, y: 0, z: 0 }]);
    const [p] = parseLas(buf, ts);
    expect(p.timestamp).toBe(ts);
  });

  it("converts GPS adjusted standard time to Unix ms for format 1 (globalEncoding bit 0 = 1)", () => {
    // GPS adjusted standard time for ~2023-01-01 00:00:00 UTC:
    //   Unix = 1_672_531_200  →  GPS std = 1_672_531_200 − 315_964_800 = 1_356_566_400
    //   GPS adjusted = 1_356_566_400 − 1_000_000_000 = 356_566_400
    const gpsAdjusted = 356_566_400;
    const expectedUnixMs = (gpsAdjusted + 1_000_000_000 + 315_964_800) * 1000;

    const buf = buildSyntheticLasBuffer(
      [{ x: 0, y: 0, z: 0 }],
      { format: 1, globalEncoding: 0x01, gpsTimesPerPoint: [gpsAdjusted] },
    );
    const [p] = parseLas(buf, Date.now());
    expect(p.timestamp).toBe(expectedUnixMs);
  });

  it("falls back to receivedAt for format 1 with GPS week time (globalEncoding bit 0 = 0)", () => {
    const receivedAt = 1_700_000_000_000;
    const buf = buildSyntheticLasBuffer(
      [{ x: 0, y: 0, z: 0 }],
      { format: 1, globalEncoding: 0x00, gpsTimesPerPoint: [12345.678] },
    );
    const [p] = parseLas(buf, receivedAt);
    expect(p.timestamp).toBe(receivedAt);
  });

  it("throws LasParseError for an empty buffer", () => {
    expect(() => parseLas(Buffer.alloc(10), Date.now())).toThrow(LasParseError);
  });

  it("throws LasParseError for an invalid file signature", () => {
    const buf = Buffer.alloc(300, 0xff);
    expect(() => parseLas(buf, Date.now())).toThrow(LasParseError);
  });

  it("throws LasParseError for a truncated point section", () => {
    // Build a valid buffer then slice it short
    const full = buildSyntheticLasBuffer([
      { x: 1, y: 2, z: 3 },
      { x: 4, y: 5, z: 6 },
    ]);
    const truncated = full.subarray(0, full.length - 5);
    expect(() => parseLas(truncated, Date.now())).toThrow(LasParseError);
  });

  it("handles a single-point buffer without error", () => {
    const buf = buildSyntheticLasBuffer([{ x: 100.0, y: 200.0, z: 10.0, intensity: 500 }]);
    const result = parseLas(buf, Date.now());
    expect(result).toHaveLength(1);
    expect(result[0].intensity).toBe(500);
  });

  it("parses classification and return metadata per point", () => {
    const buf = buildSyntheticLasBuffer([
      { x: 0, y: 0, z: 0, classification: 2 },   // ground
      { x: 1, y: 1, z: 1, classification: 5 },   // high vegetation
      { x: 2, y: 2, z: 2, classification: 7 },   // noise
    ]);
    const result = parseLas(buf, Date.now());
    expect(result[0].classification).toBe(2);
    expect(result[1].classification).toBe(5);
    expect(result[2].classification).toBe(7);
  });
});

describe("parseLas — format 6 (LAS 1.4 extended records)", () => {
  it("parses XYZ coordinates from a format-6 buffer", () => {
    const pts = [{ x: 526914.12, y: 5040778.56, z: 50.0 }];
    const buf = buildSyntheticLasBuffer(pts, { format: 6 });
    const result = parseLas(buf, Date.now());
    expect(result).toHaveLength(1);
    expect(result[0].x).toBeCloseTo(pts[0].x, 1);
    expect(result[0].y).toBeCloseTo(pts[0].y, 1);
    expect(result[0].z).toBeCloseTo(pts[0].z, 1);
  });

  it("reads classification from byte 16 (not byte 15) in format 6", () => {
    const buf = buildSyntheticLasBuffer(
      [
        { x: 0, y: 0, z: 0, classification: 2 },
        { x: 1, y: 1, z: 1, classification: 5 },
        { x: 2, y: 2, z: 2, classification: 7 },
      ],
      { format: 6 },
    );
    const result = parseLas(buf, Date.now());
    expect(result[0].classification).toBe(2);
    expect(result[1].classification).toBe(5);
    expect(result[2].classification).toBe(7);
  });

  it("converts GPS adjusted standard time from byte 22 for format 6", () => {
    const gpsAdjusted = 356_566_400;
    const expectedUnixMs = (gpsAdjusted + 1_000_000_000 + 315_964_800) * 1000;
    const buf = buildSyntheticLasBuffer(
      [{ x: 0, y: 0, z: 0 }],
      { format: 6, globalEncoding: 0x01, gpsTimesPerPoint: [gpsAdjusted] },
    );
    const [p] = parseLas(buf, Date.now());
    expect(p.timestamp).toBe(expectedUnixMs);
  });

  it("falls back to receivedAt for format 6 with GPS week time (globalEncoding bit 0 = 0)", () => {
    const receivedAt = 1_700_000_000_000;
    const buf = buildSyntheticLasBuffer(
      [{ x: 0, y: 0, z: 0 }],
      { format: 6, globalEncoding: 0x00, gpsTimesPerPoint: [12345.678] },
    );
    const [p] = parseLas(buf, receivedAt);
    expect(p.timestamp).toBe(receivedAt);
  });

  it("uses 4-bit return number and number-of-returns fields in format 6", () => {
    const buf = buildSyntheticLasBuffer([{ x: 0, y: 0, z: 0 }], { format: 6 });
    const [p] = parseLas(buf, Date.now());
    // buildSyntheticLasBuffer writes 0x11 at byte 14 for format 6: return=1, numberOfReturns=1
    expect(p.returnNumber).toBe(1);
    expect(p.numberOfReturns).toBe(1);
  });
});

describe("filterOutliers — edge cases for ingestion pipeline", () => {
  it("removes LAS noise class (7) points regardless of statistics", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({
      latitude: 45.5 + i * 0.001,
      longitude: -122.6,
      elevation: 50 + i,
      intensity: 1000,
      classification: i === 3 ? 7 : 1,
      timestamp: i,
    }));
    const result = filterOutliers(pts);
    expect(result.every((p) => p.classification !== 7)).toBe(true);
    expect(result).toHaveLength(9);
  });

  it("removes points with non-finite coordinates", () => {
    const pts = [
      { latitude: 45.5, longitude: -122.6, elevation: 50, intensity: 1000, classification: 1, timestamp: 0 },
      { latitude: NaN, longitude: -122.6, elevation: 50, intensity: 1000, classification: 1, timestamp: 1 },
      { latitude: 45.5, longitude: Infinity, elevation: 50, intensity: 1000, classification: 1, timestamp: 2 },
    ];
    const result = filterOutliers(pts);
    expect(result).toHaveLength(1);
  });

  it("returns an empty array for an empty input", () => {
    expect(filterOutliers([])).toEqual([]);
  });

  it("removes elevation outliers beyond the z-score threshold", () => {
    const base = Array.from({ length: 98 }, (_, i) => ({
      latitude: 45.5,
      longitude: -122.6,
      elevation: 50 + i * 0.1,
      intensity: 1000,
      classification: 1,
      timestamp: i,
    }));
    // Two extreme outlier elevations
    base.push({ ...base[0], elevation: 9999, timestamp: 998 });
    base.push({ ...base[0], elevation: -9999, timestamp: 999 });

    const result = filterOutliers(base, { elevationZScoreThreshold: 3.0 });
    expect(result.length).toBe(98);
    expect(result.every((p) => p.elevation < 9000)).toBe(true);
  });
});
