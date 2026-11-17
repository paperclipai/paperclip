import { describe, expect, it } from "vitest";
import { GoogleToolError } from "../errors.js";
import { mapLimited, unlessMissing } from "./parallel.js";

describe("mapLimited", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimited(Array.from({ length: 25 }, (_, index) => index), async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return value * 2;
    }, 10);
    expect(results).toEqual(Array.from({ length: 25 }, (_, index) => index * 2));
    expect(peak).toBe(10);
  });

  it("stops starting new reads after a failure", async () => {
    const started: number[] = [];
    await expect(mapLimited(Array.from({ length: 30 }, (_, index) => index), async (value) => {
      started.push(value);
      if (value === 0) throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return value;
    }, 2)).rejects.toThrow("boom");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started.length).toBeLessThanOrEqual(3);
  });
});

describe("unlessMissing", () => {
  it("turns not_found into null and rethrows everything else", async () => {
    await expect(unlessMissing(Promise.reject(new GoogleToolError("not_found", "gone", 404)))).resolves.toBeNull();
    await expect(unlessMissing(Promise.reject(new GoogleToolError("unavailable", "down", 503)))).rejects.toThrow("down");
    await expect(unlessMissing(Promise.resolve(1))).resolves.toBe(1);
  });
});
