import { describe, it, expect } from "vitest";
import { filterOutliers } from "../filter.js";
import type { NormalizedPoint } from "../types.js";

function pt(overrides: Partial<NormalizedPoint> = {}): NormalizedPoint {
  return {
    latitude: 45.5,
    longitude: -122.6,
    elevation: 50,
    intensity: 1000,
    classification: 1,
    timestamp: 0,
    ...overrides,
  };
}

describe("filterOutliers — intensity outliers", () => {
  it("removes intensity outliers beyond the default threshold (3.5 SD)", () => {
    const base = Array.from({ length: 98 }, (_, i) =>
      pt({ intensity: 1_000 + i * 2, timestamp: i }),
    );
    base.push(pt({ intensity: 99_999, timestamp: 998 }));
    base.push(pt({ intensity: -99_999, timestamp: 999 }));
    const result = filterOutliers(base);
    expect(result).toHaveLength(98);
    expect(result.every((p) => Math.abs(p.intensity) < 90_000)).toBe(true);
  });

  it("respects a tighter intensityZScoreThreshold", () => {
    const base = Array.from({ length: 20 }, (_, i) =>
      pt({ intensity: 1_000 + i * 10, timestamp: i }),
    );
    base.push(pt({ intensity: 5_000, timestamp: 20 }));
    const strict = filterOutliers(base, { intensityZScoreThreshold: 1.0 });
    const relaxed = filterOutliers(base, { intensityZScoreThreshold: 10.0 });
    expect(strict.length).toBeLessThan(relaxed.length);
  });
});

describe("filterOutliers — zero-standard-deviation handling", () => {
  it("keeps all points when all elevations are identical (std = 0, z-score = 0)", () => {
    const pts = Array.from({ length: 5 }, (_, i) =>
      pt({ elevation: 50, timestamp: i }),
    );
    // Threshold of 0.1 would normally be very aggressive, but std=0 → z=0 for every point
    const result = filterOutliers(pts, { elevationZScoreThreshold: 0.1 });
    expect(result).toHaveLength(5);
  });

  it("keeps all points when all intensities are identical (std = 0, z-score = 0)", () => {
    const pts = Array.from({ length: 5 }, (_, i) =>
      pt({ intensity: 1_000, timestamp: i }),
    );
    const result = filterOutliers(pts, { intensityZScoreThreshold: 0.1 });
    expect(result).toHaveLength(5);
  });
});

describe("filterOutliers — compound scenarios", () => {
  it("removes both an elevation outlier and an intensity outlier from the same batch", () => {
    const base = Array.from({ length: 98 }, (_, i) =>
      pt({ elevation: 50 + i * 0.1, intensity: 1_000 + i * 2, timestamp: i }),
    );
    base.push(pt({ elevation: 9_999, intensity: 1_050, timestamp: 998 }));
    base.push(pt({ elevation: 55, intensity: 99_999, timestamp: 999 }));
    const result = filterOutliers(base);
    expect(result).toHaveLength(98);
  });

  it("passes all valid inlier points through when nothing is an outlier", () => {
    const pts = Array.from({ length: 20 }, (_, i) =>
      pt({ elevation: 50 + i * 0.5, intensity: 900 + i * 10, timestamp: i }),
    );
    expect(filterOutliers(pts)).toHaveLength(20);
  });

  it("handles a single-point input without error", () => {
    expect(filterOutliers([pt()])).toHaveLength(1);
  });

  it("handles two identical points without error", () => {
    expect(filterOutliers([pt(), pt({ timestamp: 1 })])).toHaveLength(2);
  });
});
