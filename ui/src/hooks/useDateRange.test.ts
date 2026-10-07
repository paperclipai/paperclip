import { expect, it, vi } from "vitest";
import { computeRange } from "./useDateRange";

it.each([
  ["mtd", "2026-10-01T00:30:00.000Z", "2026-10-01T00:00:00.000Z"],
  ["ytd", "2026-01-01T00:30:00.000Z", "2026-01-01T00:00:00.000Z"],
] as const)("starts %s at the UTC boundary even before local midnight", (preset, now, from) => {
  vi.stubEnv("TZ", "Pacific/Honolulu");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(now));
    expect(new Date().getTimezoneOffset()).toBe(600);
    expect(computeRange(preset)).toEqual({ from, to: now });
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
