import { afterEach, describe, expect, it, vi } from "vitest";
import { nextCronTickInTimeZone } from "./routines.js";

describe("nextCronTickInTimeZone formatter caching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes the next occurrence of a sparse monthly cron correctly", () => {
    const next = nextCronTickInTimeZone(
      "30 6 1 * *",
      "America/New_York",
      new Date("2026-06-02T00:00:00Z"),
    );

    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-07-01T10:30:00.000Z");
  });

  it("does not construct a new Intl.DateTimeFormat per minute-step", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    let constructions = 0;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      constructions += 1;
      return new RealDateTimeFormat(...args);
    } as unknown as typeof Intl.DateTimeFormat);

    const next = nextCronTickInTimeZone(
      "0 12 1 * *",
      "Pacific/Kiritimati",
      new Date("2026-06-01T12:01:00Z"),
    );

    expect(next).not.toBeNull();
    expect(constructions).toBeLessThanOrEqual(1);

    constructions = 0;
    nextCronTickInTimeZone("0 12 1 * *", "Pacific/Kiritimati", new Date("2026-06-01T12:01:00Z"));
    expect(constructions).toBe(0);
  });
});
