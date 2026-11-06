import { describe, expect, it } from "vitest";
import { parseKimiUsage } from "./quota.js";

const fixture = {
  usages: {
    limit_5h: { used_ratio: 0.0889, reset_time: "2026-11-06T18:34:53Z" },
    limit_month_total: { used_ratio: 0.1426, reset_time: "2026-11-24T00:00:00Z" },
    limit_month_code: { used_ratio: 0.1384, reset_time: "2026-11-24T00:00:00Z" },
  },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "9", remaining: "91" },
    },
  ],
};

describe("parseKimiUsage", () => {
  it("maps the three reported windows with percent and reset times", () => {
    const windows = parseKimiUsage(fixture);
    expect(windows.map((window) => window.label)).toEqual([
      "5 hours",
      "Month (all features)",
      "Month (coding)",
    ]);
    expect(windows[0]).toMatchObject({
      usedPercent: 8.89,
      resetsAt: "2026-11-06T18:34:53Z",
      valueLabel: "91/100",
      detail: "Limit per 300 minutes",
    });
    expect(windows[1]?.usedPercent).toBe(14.26);
    expect(windows[2]?.usedPercent).toBe(13.84);
  });

  it("reports an unknown ratio as null instead of zero", () => {
    // Number(null) is 0, so a missing used_ratio must not become "0% used".
    const windows = parseKimiUsage({
      usages: { limit_month_total: { used_ratio: null, reset_time: null } },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBeNull();
  });

  it("reports a blank ratio as null instead of zero", () => {
    const windows = parseKimiUsage({
      usages: { limit_month_total: { used_ratio: "", reset_time: null } },
    });
    expect(windows[0]?.usedPercent).toBeNull();
  });

  it("accepts a 0..100 scale when the provider stops sending a ratio", () => {
    const windows = parseKimiUsage({
      usages: { limit_month_total: { used_ratio: 42, reset_time: null } },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBe(42);
    expect(windows[0]?.resetsAt).toBeNull();
  });

  it("omits windows the provider does not report", () => {
    const windows = parseKimiUsage({ usages: { limit_5h: { used_ratio: 0.01 } } });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.valueLabel).toBeNull();
    expect(windows[0]?.detail).toBeNull();
  });

  it("returns nothing for a malformed payload", () => {
    expect(parseKimiUsage(null)).toEqual([]);
    expect(parseKimiUsage("nope")).toEqual([]);
    expect(parseKimiUsage({})).toEqual([]);
    expect(parseKimiUsage({ usages: "nope" })).toEqual([]);
  });
});
