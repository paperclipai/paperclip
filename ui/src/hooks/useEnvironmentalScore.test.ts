import { describe, expect, it } from "vitest";

// Unit tests for bbox stabilization logic — no React/DOM required.
// The core invariant: equal bbox VALUES must produce the same query key,
// even when the caller passes a new array reference on every render.

function bboxKey(bbox: number[] | null | undefined): string | null {
  return bbox ? JSON.stringify(bbox) : null;
}

describe("useHealthScoreMap bbox key stabilization", () => {
  it("produces the same key for two arrays with identical values", () => {
    const a = [10, 20, 30, 40];
    const b = [10, 20, 30, 40];
    expect(bboxKey(a)).toBe(bboxKey(b));
  });

  it("produces different keys for arrays with different values", () => {
    expect(bboxKey([10, 20, 30, 40])).not.toBe(bboxKey([10, 20, 30, 41]));
  });

  it("returns null when bbox is null", () => {
    expect(bboxKey(null)).toBeNull();
  });

  it("returns null when bbox is undefined", () => {
    expect(bboxKey(undefined)).toBeNull();
  });

  it("round-trips through JSON without loss of precision for integer coords", () => {
    const bbox = [51.5, -0.12, 51.52, -0.1];
    const parsed = JSON.parse(bboxKey(bbox)!);
    expect(parsed).toEqual(bbox);
  });

  it("does not treat distinct bbox regions as equal", () => {
    const nyc: [number, number, number, number] = [40.49, -74.26, 40.92, -73.7];
    const la: [number, number, number, number] = [33.7, -118.67, 34.34, -118.15];
    expect(bboxKey(nyc)).not.toBe(bboxKey(la));
  });

  it("global (no-bbox) key is null, distinct from any bounded query", () => {
    const bounded = bboxKey([0, 0, 1, 1]);
    const global_ = bboxKey(null);
    expect(global_).toBeNull();
    expect(bounded).not.toBeNull();
    expect(bounded).not.toBe(global_);
  });
});
