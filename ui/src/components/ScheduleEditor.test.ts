import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  getScheduleEditorPresetForTest,
  hasSingleMinuteAcrossTimesForTest,
  parseCronToPreset,
  roundTripCronForTest,
} from "./ScheduleEditor";

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

    it("routes hourly-on-weekdays schedules to custom to preserve the stored expression", () => {
      expect(getScheduleEditorPresetForTest("5 * * * 1-5")).toBe("custom");
      expect(roundTripCronForTest("5 * * * 1-5")).toBe("5 * * * 1-5");
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
    expect(describeSchedule("0 9 * * 1-5")).toContain("weekday");
    expect(describeSchedule("0 9 * * 1")).toContain("Monday");
  });

  it("describes multi-value hour lists (these previously collapsed silently)", () => {
    // Regression guard. Pre-fix, these crons round-tripped to "Every day at …"
    // with a silently-wrong single hour. Post-fix they rendered as the raw
    // cron string. Now that the editor can represent multi-value hour lists
    // first-class, describeSchedule unfolds them into a readable sentence.
    expect(describeSchedule("0 9,13,17 * * *")).toBe("Every day at 09:00, 13:00 and 17:00");
    expect(describeSchedule("0 10,16 * * *")).toBe("Every day at 10:00 and 16:00");
  });

  it("describes step expressions in plain English", () => {
    expect(describeSchedule("0 */4 * * *")).toBe("Every 4 hours at :00");
    expect(describeSchedule("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeSchedule("*/15 9-17 * * 1-5")).toContain("between 09:00 and 17:00");
  });

  it("describes multi-day weekday selections", () => {
    expect(describeSchedule("0 9 * * 1,3,5")).toBe("Every Mon, Wed, Fri at 09:00");
  });

  it("describes multi-date monthly selections with ordinals", () => {
    expect(describeSchedule("0 9 1,15 * *")).toBe("On the 1st, 15th of the month at 09:00");
  });

  it("falls back to the raw cron string for expressions it can't confidently describe", () => {
    // Named tokens and exotic forms still round-trip as the raw cron.
    expect(describeSchedule("0 MON * * *")).toBe("0 MON * * *");
    expect(describeSchedule("@daily")).toBe("@daily");
    expect(describeSchedule("not a cron")).toBe("not a cron");
  });

  it("falls back to the default 10:00 preset for an empty cron", () => {
    expect(describeSchedule("")).toBe("Every day at 10:00");
  });
});

describe("getScheduleEditorPresetForTest", () => {
  it("keeps malformed hour fields in custom mode instead of coercing them into daily", () => {
    expect(getScheduleEditorPresetForTest("0 foo * * *")).toBe("custom");
    expect(getScheduleEditorPresetForTest("0 9-foo * * *")).toBe("custom");
  });

  it("keeps multi-minute daily schedules in custom mode because one trigger cannot represent arbitrary time pairs", () => {
    expect(getScheduleEditorPresetForTest("15,45 9,13 * * *")).toBe("custom");
  });
});

describe("roundTripCronForTest", () => {
  it("preserves weekday ranges instead of normalizing them to a comma list", () => {
    expect(roundTripCronForTest("0 9 * * 1-5")).toBe("0 9 * * 1-5");
  });
});

describe("hasSingleMinuteAcrossTimesForTest", () => {
  it("accepts same-minute multi-time selections", () => {
    expect(hasSingleMinuteAcrossTimesForTest(["09:00", "13:00", "17:00"])).toBe(true);
  });

  it("rejects mixed-minute selections that would expand into extra cron runs", () => {
    expect(hasSingleMinuteAcrossTimesForTest(["09:15", "13:45"])).toBe(false);
  });
});
