import { describe, expect, it } from "vitest";
import { nextCronFires, parseCronExpression, previewFirePolicies } from "./cron-fires";

describe("parseCronExpression", () => {
  it("parses a standard 5-field expression", () => {
    const parsed = parseCronExpression("0 14 * * 1-5");
    expect(parsed).not.toBeNull();
    expect(parsed?.minutes).toEqual([0]);
    expect(parsed?.hours).toEqual([14]);
    expect(parsed?.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null for malformed expressions", () => {
    expect(parseCronExpression("not a cron")).toBeNull();
    expect(parseCronExpression("0 14 * *")).toBeNull();
    expect(parseCronExpression("")).toBeNull();
    expect(parseCronExpression(null)).toBeNull();
  });
});

describe("nextCronFires", () => {
  it("computes the next N daily fires in UTC", () => {
    const after = new Date("2026-06-09T10:00:00Z");
    const fires = nextCronFires("0 14 * * *", 3, { after, timeZone: "UTC" });
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-09T14:00:00.000Z",
      "2026-06-10T14:00:00.000Z",
      "2026-06-11T14:00:00.000Z",
    ]);
  });

  it("skips weekends for a weekday schedule", () => {
    // 2026-06-12 is a Friday; the next weekday fire after Fri is Mon 2026-06-15.
    const after = new Date("2026-06-12T15:00:00Z");
    const fires = nextCronFires("0 14 * * 1-5", 2, { after, timeZone: "UTC" });
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-15T14:00:00.000Z",
      "2026-06-16T14:00:00.000Z",
    ]);
  });

  it("uses OR semantics when day-of-month and day-of-week are both restricted", () => {
    const after = new Date("2026-06-09T10:00:00Z");
    const fires = nextCronFires("0 9 15 * 5", 3, { after, timeZone: "UTC" });
    expect(fires.map((d) => d.toISOString())).toEqual([
      "2026-06-12T09:00:00.000Z",
      "2026-06-15T09:00:00.000Z",
      "2026-06-19T09:00:00.000Z",
    ]);
  });

  it("interprets cron fields in the trigger timezone", () => {
    // 14:00 in New York (EDT, UTC-4 in June) is 18:00 UTC.
    const after = new Date("2026-06-09T10:00:00Z");
    const fires = nextCronFires("0 14 * * *", 1, { after, timeZone: "America/New_York" });
    expect(fires[0]?.toISOString()).toBe("2026-06-09T18:00:00.000Z");
  });

  it("returns an empty list for an unparseable expression", () => {
    expect(nextCronFires("garbage", 5)).toEqual([]);
    expect(nextCronFires("0 14 * * *", 0)).toEqual([]);
  });
});

describe("previewFirePolicies", () => {
  const fires = [
    new Date("2026-06-09T14:00:00Z"),
    new Date("2026-06-10T14:00:00Z"),
    new Date("2026-06-11T14:00:00Z"),
  ];

  it("always queues the first fire regardless of policy", () => {
    for (const policy of ["coalesce_if_active", "always_enqueue", "skip_if_active"]) {
      expect(previewFirePolicies(fires, policy)[0]?.disposition).toBe("queued");
    }
  });

  it("coalesces subsequent fires under coalesce_if_active", () => {
    const preview = previewFirePolicies(fires, "coalesce_if_active");
    expect(preview.map((e) => e.disposition)).toEqual(["queued", "coalesced", "coalesced"]);
    expect(preview[1]?.label).toBe("would be coalesced");
  });

  it("skips subsequent fires under skip_if_active", () => {
    const preview = previewFirePolicies(fires, "skip_if_active");
    expect(preview.map((e) => e.disposition)).toEqual(["queued", "skipped", "skipped"]);
  });

  it("queues every fire under always_enqueue", () => {
    const preview = previewFirePolicies(fires, "always_enqueue");
    expect(preview.every((e) => e.disposition === "queued")).toBe(true);
  });

  it("defaults unknown policies to coalesce", () => {
    const preview = previewFirePolicies(fires, "mystery");
    expect(preview[1]?.disposition).toBe("coalesced");
  });
});
