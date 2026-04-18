// @vitest-environment node

import { describe, expect, it } from "vitest";
import { calculateFitTransform } from "./org-chart-fit";

describe("calculateFitTransform", () => {
  it("returns null until the chart viewport has measurable dimensions", () => {
    expect(calculateFitTransform(0, 500, { width: 320, height: 220 })).toBeNull();
    expect(calculateFitTransform(280, 0, { width: 320, height: 220 })).toBeNull();
  });

  it("recomputes a centered fit transform for narrow portrait-sized viewports", () => {
    expect(calculateFitTransform(280, 500, { width: 320, height: 220 })).toEqual({
      zoom: 0.75,
      pan: {
        x: 20,
        y: 167.5,
      },
    });

    expect(calculateFitTransform(240, 500, { width: 320, height: 220 })).toEqual({
      zoom: 0.625,
      pan: {
        x: 20,
        y: 181.25,
      },
    });
  });
});
