import { describe, expect, it } from "vitest";
import { describeSchedule, parseCronToPreset } from "./ScheduleEditor";

describe("parseCronToPreset", () => {
  describe("simple single-value crons map to presets", () => {
    it("maps `* * * * *` to every_minute", () => {
      expect(parseCronToPreset("* * * * *").preset).toBe("every_minute");
    });

    it("maps `0 * * * *` to every_hour", () => {
      const parsed = parseCronToPreset("0 * * * *");
      expect(parsed.preset).toBe("every_hour");
      expect(parsed.minute).toBe("0");
    });

    it("maps `0 9 * * *` to every_day at 09:00", () => {
      const parsed = parseCronToPreset("0 9 * * *");
      expect(parsed.preset).toBe("every_day");
      expect(parsed.hour).toBe("9");
      expect(parsed.minute).toBe("0");
    });

    it("maps `0 9 * * 1-5` to weekdays", () => {
      const parsed = parseCronToPreset("0 9 * * 1-5");
      expect(parsed.preset).toBe("weekdays");
      expect(parsed.hour).toBe("9");
    });

    it("maps `0 9 * * 1` to weekly on Monday", () => {
      const parsed = parseCronToPreset("0 9 * * 1");
      expect(parsed.preset).toBe("weekly");
      expect(parsed.dayOfWeek).toBe("1");
      expect(parsed.hour).toBe("9");
    });

    it("maps `0 9 1 * *` to monthly on the 1st", () => {
      const parsed = parseCronToPreset("0 9 1 * *");
      expect(parsed.preset).toBe("monthly");
      expect(parsed.dayOfMonth).toBe("1");
      expect(parsed.hour).toBe("9");
    });
  });

  describe("complex crons round-trip via custom preset (regression: comma lists were silently coerced into every_day)", () => {
    it("routes comma-separated hours to custom", () => {
      // Regression: `0 9,13,17 * * *` used to be parsed as `every_day` with
      // hour `"9,13,17"`, which the hour <Select> couldn't render. Saving the
      // form then rebuilt the cron as `0 10 * * *`, silently collapsing three
      // daily fires into one.
      expect(parseCronToPreset("0 9,13,17 * * *").preset).toBe("custom");
      expect(parseCronToPreset("0 10,16 * * *").preset).toBe("custom");
    });

    it("routes step expressions to custom", () => {
      expect(parseCronToPreset("0 */4 * * *").preset).toBe("custom");
      expect(parseCronToPreset("*/15 * * * *").preset).toBe("custom");
      expect(parseCronToPreset("0 9-17/2 * * *").preset).toBe("custom");
    });

    it("routes range expressions (other than weekday 1-5) to custom", () => {
      expect(parseCronToPreset("0 9-17 * * *").preset).toBe("custom");
      expect(parseCronToPreset("15-45 * * * *").preset).toBe("custom");
      expect(parseCronToPreset("0 9 1-15 * *").preset).toBe("custom");
    });

    it("routes comma-separated day-of-week to custom", () => {
      expect(parseCronToPreset("0 9 * * 1,3,5").preset).toBe("custom");
    });

    it("routes non-wildcard month field to custom", () => {
      // None of the presets encode a month, so even a single numeric month
      // must fall through to custom to avoid being silently dropped.
      expect(parseCronToPreset("0 9 1 1 *").preset).toBe("custom");
    });

    it("routes unknown tokens to custom", () => {
      expect(parseCronToPreset("0 MON * * *").preset).toBe("custom");
      expect(parseCronToPreset("@daily").preset).toBe("custom");
    });

    it("routes malformed crons to custom", () => {
      expect(parseCronToPreset("not a cron").preset).toBe("custom");
      expect(parseCronToPreset("0 9 *").preset).toBe("custom");
    });
  });
});

describe("describeSchedule", () => {
  it("describes simple presets in plain English", () => {
    expect(describeSchedule("0 9 * * *")).toContain("Every day");
    expect(describeSchedule("0 9 * * 1-5")).toContain("Weekdays");
    expect(describeSchedule("0 9 * * 1")).toContain("Mon");
  });

  it("returns the raw cron string for complex crons (so the user sees what's actually scheduled)", () => {
    // These are the three patterns in the Traffic Exchange Script company's
    // routines that exposed the round-trip bug. Before the fix they all
    // rendered as some variant of "Every day at …" with a silently wrong
    // hour. After the fix they render as the cron string itself.
    expect(describeSchedule("0 9,13,17 * * *")).toBe("0 9,13,17 * * *");
    expect(describeSchedule("0 10,16 * * *")).toBe("0 10,16 * * *");
    expect(describeSchedule("0 */4 * * *")).toBe("0 */4 * * *");
  });

  it("falls back to the default 10:00 AM preset for an empty cron", () => {
    // `parseCronToPreset("")` returns `every_day` with the default hour (10)
    // and minute (0), so `describeSchedule` renders the default preset label.
    expect(describeSchedule("")).toBe("Every day at 10:00 AM");
  });
});
